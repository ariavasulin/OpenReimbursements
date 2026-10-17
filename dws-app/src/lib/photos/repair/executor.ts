import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WorkBudget } from './deadline';
import { downloadOriginal, MediaProcessingLimit } from './download';
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
import { DERIVED_CACHE_SECONDS } from '../storage-cache';


const BUCKET = 'photos';
const POSTER_BYTES = 8 * 1024 * 1024;
export { downloadOriginal, MediaProcessingLimit };

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

  /** The stored original's address. The bucket is public, so a plain fetch
   * (or ffmpeg) can read it; supabase-js download() would buffer the whole clip. */
  function originalUrl(row: RepairRow) {
    return supabaseAdmin.storage.from(BUCKET).getPublicUrl(row.original_path).data.publicUrl;
  }

  function checkVideoCap(row: RepairRow) {
    if ((row.original_bytes ?? 0) > CAP.bytes) throw new MediaProcessingLimit(`original exceeds ${CAP.bytes} bytes`);
  }

  /** Streams the stored original into `dir` and reads its duration — the shared
   * prefix of both video actions, so a row that needs a poster AND a rendition
   * pays for the download and the probe once. */
  async function fetchAndProbe(row: RepairRow, dir: string) {
    checkVideoCap(row);
    const input = path.join(dir, `input${path.extname(row.original_path) || '.bin'}`);
    await downloadOriginal(originalUrl(row), input, budget, CAP.bytes);
    const { durationSecs } = await probe(input, budget);
    return { input, durationSecs };
  }

  type PosterFrames = { key: string; body: Buffer }[];

  /** One frame of `input` (a file or a URL) at thumb and preview sizes,
   * bound for the same derived/ keys the client would have written. */
  async function extractPoster(
    row: RepairRow,
    dir: string,
    input: string,
    durationSecs: number | null
  ): Promise<PosterFrames> {
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
    return Promise.all(outputs.map(async (out) => ({
      key: out.key,
      body: await readOutput(out.path, POSTER_BYTES, budget),
    })));
  }

  /** Poster for a row that needs nothing else (UP-5). First straight from
   * the original's URL: ffmpeg range-reads the header and the bytes around
   * the frame, a few MB, where the download copies the whole clip (up to
   * 200 MB) into /tmp first. When that read fails (an MP4 whose index sits at
   * its end and cannot be reached by seeking, a dropped connection, a
   * duration the header does not state) the clip is downloaded as before. */
  async function posterFromOriginal(row: RepairRow, dir: string) {
    checkVideoCap(row);
    const url = originalUrl(row);
    try {
      // probe swallows ffmpeg's own failures as an unknown duration; a
      // poster recorded with a null duration would hide the real one, so an
      // unknown duration here goes to the download too.
      const { durationSecs } = await probe(url, budget);
      if (durationSecs !== null) {
        return { frames: await extractPoster(row, dir, url, durationSecs), durationSecs };
      }
    } catch (error) {
      // Out of time, or an output over its cap: the download would end the same way.
      budget.check();
      if (error instanceof MediaProcessingLimit) throw error;
      console.info(`photos.repair posterFromUrl photoId=${row.id} fallback=download err=${error instanceof Error ? error.message.split('\n')[0] : error}`);
    }
    const { input, durationSecs } = await fetchAndProbe(row, dir);
    return { frames: await extractPoster(row, dir, input, durationSecs), durationSecs };
  }

  /** Upload a poster's frames and record the probed duration on the row. */
  async function storePoster(row: RepairRow, frames: PosterFrames, durationSecs: number | null) {
    const keys = derivedKeys(row.uploader_id, row.id);
    await Promise.all(
      frames.map(async (out) => {
        const { error } = await budget.run(() => supabaseAdmin.storage
          .from(BUCKET)
          .upload(out.key, out.body, {
            contentType: 'image/webp',
            upsert: true,
            cacheControl: DERIVED_CACHE_SECONDS,
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
        cacheControl: DERIVED_CACHE_SECONDS,
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
            const { frames, durationSecs } = await posterFromOriginal(row, dir);
            await storePoster(row, frames, durationSecs);
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
              await storePoster(row, await extractPoster(row, dir, input, durationSecs), durationSecs);
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
