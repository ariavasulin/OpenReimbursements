import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WorkBudget } from './deadline';
import {
  derivedKeys,
  type Action,
  type RepairRow,
} from './sweep';
import { fillImageDerivatives } from './transforms';
import {
  capReason,
  CAP,
  poster,
  probe,
  transcode,
} from './transcode';
import {
  POSTER_SEEK_SECS,
  PREVIEW_MAX_DIM,
  THUMB_MAX_DIM,
} from '../derivatives';


const BUCKET = 'photos';
const POSTER_BYTES = 8 * 1024 * 1024;
export class MediaProcessingLimit extends Error {
  constructor(detail: string) {
    super(`repair media processing limit: ${detail}; generate derivatives in the upload client`);
    this.name = 'MediaProcessingLimit';
  }
}

/** Never trust Content-Length (or row metadata) to bound bytes written to /tmp. */
export async function downloadOriginal(url: string, input: string, budget: WorkBudget, maxBytes = CAP.bytes) {
  await budget.run(async signal => {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`download original: ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body.cancel();
      throw new MediaProcessingLimit(`original exceeds ${maxBytes} bytes`);
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) next(new MediaProcessingLimit(`original exceeds ${maxBytes} bytes`));
        else next(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), limit, createWriteStream(input), { signal });
  });
}

/** ffmpeg -fs can leave a successfully exited but truncated file. Reject it
 * before reading/uploading; the cap is a processing failure, never playback. */
async function readOutput(file: string, maxBytes: number, budget: WorkBudget) {
  return budget.run(async signal => {
    if ((await stat(file)).size >= maxBytes) throw new MediaProcessingLimit(`output reached ${maxBytes} bytes`);
    return readFile(file, { signal });
  });
}

export type CountKey = Action['action'] | 'playbackSkipped' | 'posterSkipped' | 'transcodeDeferred' | 'orphanDeleteSkipped' | 'deadRowDeleteSkipped';
/** All media and metadata work shares the caller's absolute deadline/client. */
export function mediaExecutor(supabaseAdmin: SupabaseClient, budget: WorkBudget) {
  async function markFileTile(photoId: string, reason: string) {
    const { data: changed, error } = await budget.run(signal => supabaseAdmin
      .from('photos')
      .update({ kind: 'file' })
      .eq('id', photoId).is('deleted_at', null).select('id').abortSignal(signal).maybeSingle());
    if (!error && !changed) throw new Error('photo no longer active');
    if (error) throw new Error(`markFileTile ${photoId}: ${error.message}`);
    console.info(`photos.repair markFileTile photoId=${photoId} reason=${reason}`);
  }

  /** Temp workspace for one ffmpeg action, removed no matter what. */
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    budget.check();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'photos-repair-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Streams the stored original into `dir` and reads its duration — the shared
   * prefix of both video actions, so a row that needs a poster AND a rendition
   * pays for the download and the probe once. (The bucket is public, so a plain
   * fetch streams; supabase-js download() would buffer the whole clip.) */
  async function fetchAndProbe(row: RepairRow, dir: string) {
    if ((row.original_bytes ?? 0) > CAP.bytes) throw new MediaProcessingLimit(`original exceeds ${CAP.bytes} bytes`);
    const input = path.join(dir, `input${path.extname(row.original_path) || '.bin'}`);
    const { data } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(row.original_path);
    await downloadOriginal(data.publicUrl, input, budget);
    const { durationSecs } = await probe(input, budget);
    return { input, durationSecs };
  }

  /** Poster for a video row missing its thumb: extract one frame, upload it at
   * thumb and preview sizes to the same derived/ keys the client would have
   * written, and record the probed duration. */
  async function writePoster(
    row: RepairRow,
    dir: string,
    input: string,
    durationSecs: number | null
  ) {
    // Frame 0 is often black, so seek ~1s in — unless the clip is shorter, or
    // its duration is unknown (probe returns null), where 0 is the safe seek.
    const seek =
      durationSecs !== null && durationSecs > POSTER_SEEK_SECS ? POSTER_SEEK_SECS : 0;

    const keys = derivedKeys(row.uploader_id, row.id);
    const outputs = [
      { path: path.join(dir, 'thumb.webp'), maxDim: THUMB_MAX_DIM, key: keys.thumb },
      { path: path.join(dir, 'preview.webp'), maxDim: PREVIEW_MAX_DIM, key: keys.preview },
    ];
    await poster(input, seek, outputs, budget, POSTER_BYTES);
    await Promise.all(
      outputs.map(async (out) => {
        const body = await readOutput(out.path, POSTER_BYTES, budget);
        const { error } = await budget.run(() => supabaseAdmin.storage
          .from(BUCKET)
          .upload(out.key, body, {
            contentType: 'image/webp',
            upsert: true,
          }));
        if (error) throw new Error(`upload ${out.key}: ${error.message}`);
      })
    );

    const { data: changed, error } = await budget.run(signal => supabaseAdmin
      .from('photos')
      .update({
        thumb_path: keys.thumb,
        preview_path: keys.preview,
        duration_secs: durationSecs !== null && durationSecs > 0 ? durationSecs : null,
      })
      .eq('id', row.id).is('deleted_at', null).select('id').abortSignal(signal).maybeSingle());
    if (!error && !changed) throw new Error('photo no longer active');
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
  }

  /** H.264 rendition for a video row missing playback_path. Over-cap clips get
   * playback_skipped_reason instead, which stops the sweep from replanning
   * them. Returns the counts key. */
  async function writeRendition(
    row: RepairRow,
    dir: string,
    input: string,
    durationSecs: number | null
  ): Promise<CountKey> {
    const bytes = (await budget.run(() => stat(input))).size;
    const reason = capReason(bytes, durationSecs);
    if (reason) {
      return skipRendition(row, reason);
    }

    const output = path.join(dir, 'playback.mp4');
    budget.check();
    await transcode(input, output, budget, CAP.bytes);
    const { durationSecs: outputDuration } = await probe(output, budget);
    if (outputDuration === null || durationSecs === null || outputDuration + 0.1 < durationSecs) {
      throw new MediaProcessingLimit('rendition is incomplete');
    }
    const key = derivedKeys(row.uploader_id, row.id).playback;
    const body = await readOutput(output, CAP.bytes, budget);
    const { error: uploadError } = await budget.run(() => supabaseAdmin.storage
      .from(BUCKET)
      .upload(key, body, {
        contentType: 'video/mp4',
        upsert: true,
      }));
    if (uploadError) throw new Error(`upload ${key}: ${uploadError.message}`);

    const { data: changed, error } = await budget.run(signal => supabaseAdmin
      .from('photos')
      .update({ playback_path: key })
      .eq('id', row.id).is('deleted_at', null).select('id').abortSignal(signal).maybeSingle());
    if (!error && !changed) throw new Error('photo no longer active');
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
    return 'transcodeVideo';
  }

  async function skipRendition(row: RepairRow, reason: string): Promise<CountKey> {
    const { data: changed, error } = await budget.run(signal => supabaseAdmin
      .from('photos').update({ playback_skipped_reason: reason })
      .eq('id', row.id).is('deleted_at', null).select('id').abortSignal(signal).maybeSingle());
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
    if (!changed) throw new Error('photo no longer active');
    return 'playbackSkipped';
  }

  async function skipPoster(row: RepairRow, reason: string): Promise<CountKey> {
    const { data: changed, error } = await budget.run(signal => supabaseAdmin
      .from('photos').update({ poster_skipped_reason: reason })
      .eq('id', row.id).is('deleted_at', null).select('id').abortSignal(signal).maybeSingle());
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
    if (!changed) throw new Error('photo no longer active');
    return 'posterSkipped';
  }

  interface VideoOpts {
    /** This row's poster is due too: produce both from the one download. */
    alsoPoster: boolean;
  }

  /** Runs one action, calling `count` as each piece of work commits. Counting
   * as we go rather than on return is what keeps a paired poster's count when
   * the transcode behind it throws: the poster's row update has landed, and a
   * run that under-reports committed work can never reach `errors: []`. */
  async function execute(
    a: Action,
    row: RepairRow,
    video: VideoOpts,
    count: (key: CountKey) => void
  ): Promise<void> {
    switch (a.action) {
      case 'fillImageDerivatives': {
        const result = await fillImageDerivatives(supabaseAdmin, row, budget);
        if (!result.ok) {
          await markFileTile(a.photoId, result.reason);
          count('markFileTile');
          return;
        }
        count(a.action);
        return;
      }
      case 'markFileTile':
        await markFileTile(a.photoId, a.reason);
        count(a.action);
        return;
      case 'makeVideoPoster':
        return withTempDir(async (dir) => {
          try {
            const { input, durationSecs } = await fetchAndProbe(row, dir);
            await writePoster(row, dir, input, durationSecs);
            count(a.action);
          } catch (error) {
            if (!(error instanceof MediaProcessingLimit)) throw error;
            count(await skipPoster(row, error.message));
          }
        });
      case 'transcodeVideo':
        return withTempDir(async (dir) => {
          let source: Awaited<ReturnType<typeof fetchAndProbe>>;
          try {
            source = await fetchAndProbe(row, dir);
          } catch (error) {
            if (!(error instanceof MediaProcessingLimit)) throw error;
            count(await skipRendition(row, `over ${CAP.bytes} bytes`));
            if (video.alsoPoster) count(await skipPoster(row, error.message));
            return;
          }
          const { input, durationSecs } = source;
          if (video.alsoPoster) {
            try {
              await writePoster(row, dir, input, durationSecs);
              count('makeVideoPoster');
            } catch (error) {
              if (!(error instanceof MediaProcessingLimit)) throw error;
              count(await skipPoster(row, error.message));
            }
          }
          count(await writeRendition(row, dir, input, durationSecs));
        });
      default: throw new Error('Lifecycle action passed to media executor');
    }
  }
  return async (actions: Action[], row: RepairRow, count: (key: CountKey) => void) => {
    const paired = actions.some(a => a.action === 'transcodeVideo') && actions.some(a => a.action === 'makeVideoPoster');
    for (const action of actions) {
      if (paired && action.action === 'makeVideoPoster') continue;
      budget.check();
      await execute(action, row, { alsoPoster: paired }, count);
    }
  };
}
