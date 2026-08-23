import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import {
  planSweep,
  type Action,
  type RepairRow,
  type StoredObject,
} from '@/lib/photos/repair/sweep';
import { fillImageDerivatives } from '@/lib/photos/repair/transforms';
import {
  ENABLED as transcodeEnabled,
  capReason,
  poster,
  probe,
  transcode,
} from '@/lib/photos/repair/transcode';
import {
  POSTER_SEEK_SECS,
  PREVIEW_MAX_DIM,
  THUMB_MAX_DIM,
} from '@/lib/photos/derivatives';

// GET/POST /api/photos/repair — the daily convergence sweep (Vercel cron
// issues GET with Authorization: Bearer $CRON_SECRET; POST is for manual
// runs with the same header). Plans with the pure planner in
// lib/photos/repair/sweep.ts, then executes action-by-action, each isolated:
// one failure lands in `errors` and never aborts the rest.
//
// Scope: fill image derivatives via Supabase transforms, downgrade
// untransformable images to deliberate file tiles, delete >24h row-less
// objects and rows whose original never landed, extract video posters with
// ffmpeg, and (behind PHOTOS_TRANSCODE=1) transcode videos to an H.264
// playback rendition. Transcodes run last and stop starting once
// TRANSCODE_BUDGET_MS has elapsed, so the cheap actions always finish
// inside maxDuration; leftovers count as transcodeDeferred and the next
// run picks them up.
//
// `?olderThan=<ms>` (manual runs) overrides the 24 h orphan age for drills.

export const maxDuration = 300;

const BUCKET = 'photos';
const PAGE = 1000;
/** Stop starting new transcodes after this much wall time. */
const TRANSCODE_BUDGET_MS = 240 * 1000;

interface ListedObject {
  name: string;
  created_at: string;
}

/** One directory level, fully paginated. Folders come back with id: null. */
async function listDir(prefix: string) {
  const entries: { name: string; id: string | null; created_at: string }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    entries.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return entries;
}

/** Every object under originals/ (layout: originals/{uid}/{photoId}/{file}). */
async function listOriginals(): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  for (const uidDir of await listDir('originals')) {
    if (uidDir.id !== null) continue; // stray file at the top level — ignore
    const uidPrefix = `originals/${uidDir.name}`;
    for (const photoDir of await listDir(uidPrefix)) {
      if (photoDir.id !== null) {
        // Stray file directly under the uid: no row can point here.
        out.push({ name: `${uidPrefix}/${photoDir.name}`, created_at: photoDir.created_at });
        continue;
      }
      for (const file of await listDir(`${uidPrefix}/${photoDir.name}`)) {
        if (file.id === null) continue;
        out.push({
          name: `${uidPrefix}/${photoDir.name}/${file.name}`,
          created_at: file.created_at,
        });
      }
    }
  }
  return out;
}

async function markFileTile(photoId: string, reason: string) {
  const { error } = await supabaseAdmin
    .from('photos')
    .update({ kind: 'file' })
    .eq('id', photoId);
  if (error) throw new Error(`markFileTile ${photoId}: ${error.message}`);
  console.info(`photos.repair markFileTile photoId=${photoId} reason=${reason}`);
}

/** Streams the stored original to a local file (the bucket is public, so a
 * plain fetch streams; supabase-js download() would buffer the whole clip). */
async function downloadOriginal(originalPath: string, dest: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const url = `${base}/storage/v1/object/public/${BUCKET}/${encodeURI(originalPath)}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download ${originalPath}: ${res.status}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
    createWriteStream(dest)
  );
}

/** Temp workspace for one ffmpeg action, removed no matter what. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photos-repair-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Poster + duration for a video row missing its thumb: extract one frame,
 * upload it at thumb and preview sizes to the same derived/ keys the client
 * would have written, and record the probed duration. */
async function makeVideoPoster(row: RepairRow) {
  await withTempDir(async (dir) => {
    const input = path.join(dir, `input${path.extname(row.original_path) || '.bin'}`);
    await downloadOriginal(row.original_path, input);
    const { durationSecs } = await probe(input);
    // Frame 0 is often black, so seek ~1s in — unless the clip is shorter.
    const seek = durationSecs > POSTER_SEEK_SECS ? POSTER_SEEK_SECS : 0;

    const outputs = [
      { local: path.join(dir, 'thumb.webp'), maxDim: THUMB_MAX_DIM, key: `derived/${row.uploader_id}/${row.id}_thumb.webp` },
      { local: path.join(dir, 'preview.webp'), maxDim: PREVIEW_MAX_DIM, key: `derived/${row.uploader_id}/${row.id}_preview.webp` },
    ];
    for (const out of outputs) {
      await poster(input, out.local, out.maxDim, seek);
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(out.key, await readFile(out.local), {
          contentType: 'image/webp',
          upsert: true,
        });
      if (error) throw new Error(`upload ${out.key}: ${error.message}`);
    }

    const { error } = await supabaseAdmin
      .from('photos')
      .update({
        thumb_path: outputs[0].key,
        preview_path: outputs[1].key,
        duration_secs: durationSecs > 0 ? durationSecs : null,
      })
      .eq('id', row.id);
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
  });
}

/** H.264 rendition for a video row missing playback_path. Over-cap clips get
 * playback_skipped_reason instead, which stops the sweep from replanning
 * them. Returns the counts key. */
async function transcodeVideo(row: RepairRow): Promise<string> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, `input${path.extname(row.original_path) || '.bin'}`);
    await downloadOriginal(row.original_path, input);
    const bytes = row.original_bytes ?? (await stat(input)).size;
    const { durationSecs } = await probe(input);

    const reason = capReason(bytes, durationSecs);
    if (reason) {
      const { error } = await supabaseAdmin
        .from('photos')
        .update({ playback_skipped_reason: reason })
        .eq('id', row.id);
      if (error) throw new Error(`update ${row.id}: ${error.message}`);
      console.info(`photos.repair playbackSkipped photoId=${row.id} reason=${reason}`);
      return 'playbackSkipped';
    }

    const output = path.join(dir, 'playback.mp4');
    await transcode(input, output);
    const key = `derived/${row.uploader_id}/${row.id}_playback.mp4`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(key, await readFile(output), {
        contentType: 'video/mp4',
        upsert: true,
      });
    if (uploadError) throw new Error(`upload ${key}: ${uploadError.message}`);

    const { error } = await supabaseAdmin
      .from('photos')
      .update({ playback_path: key })
      .eq('id', row.id);
    if (error) throw new Error(`update ${row.id}: ${error.message}`);
    return 'transcodeVideo';
  });
}

/** Runs one action; returns the action name to count (fillImageDerivatives
 * downgrades to markFileTile when the transform endpoint refuses the file;
 * transcodeVideo downgrades to playbackSkipped for over-cap clips). */
async function execute(a: Action, rowsById: Map<string, RepairRow>): Promise<string> {
  switch (a.action) {
    case 'fillImageDerivatives': {
      const row = rowsById.get(a.photoId);
      if (!row) throw new Error(`no row for ${a.photoId}`);
      const result = await fillImageDerivatives(supabaseAdmin, row);
      if (!result.ok) {
        await markFileTile(a.photoId, result.reason);
        return 'markFileTile';
      }
      return a.action;
    }
    case 'markFileTile':
      await markFileTile(a.photoId, a.reason);
      return a.action;
    case 'makeVideoPoster': {
      const row = rowsById.get(a.photoId);
      if (!row) throw new Error(`no row for ${a.photoId}`);
      await makeVideoPoster(row);
      return a.action;
    }
    case 'transcodeVideo': {
      const row = rowsById.get(a.photoId);
      if (!row) throw new Error(`no row for ${a.photoId}`);
      return transcodeVideo(row);
    }
    case 'deleteOrphanObject': {
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove([a.path]);
      if (error) throw new Error(`remove ${a.path}: ${error.message}`);
      return a.action;
    }
    case 'deleteDeadRow': {
      const { error } = await supabaseAdmin
        .from('photos')
        .delete()
        .eq('id', a.photoId);
      if (error) throw new Error(`delete row ${a.photoId}: ${error.message}`);
      return a.action;
    }
  }
}

async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const olderThanRaw = new URL(request.url).searchParams.get('olderThan');
  const olderThan = olderThanRaw === null ? NaN : Number(olderThanRaw);
  const orphanMs =
    Number.isFinite(olderThan) && olderThan >= 0 ? olderThan : undefined;

  const now = Date.now();

  // Rows with a hole: a missing thumb, or a video missing its playback
  // rendition. (Rows with playback_skipped_reason set still match — the
  // planner drops them, so they never replan.)
  const { data: rows, error: rowsError } = await supabaseAdmin
    .from('photos')
    .select(
      'id, uploader_id, kind, mime_type, original_path, original_bytes, thumb_path, playback_path, playback_skipped_reason, created_at'
    )
    .or('thumb_path.is.null,and(kind.eq.video,playback_path.is.null)');
  if (rowsError) {
    return NextResponse.json({ error: rowsError.message }, { status: 500 });
  }

  // Paths some row points at — originals AND sidecars, which share the
  // originals/{uid}/{photoId}/ prefix and must not read as orphans.
  const { data: knownRows, error: knownError } = await supabaseAdmin
    .from('photos')
    .select('original_path, sidecar_path');
  if (knownError) {
    return NextResponse.json({ error: knownError.message }, { status: 500 });
  }
  const known = new Set<string>();
  for (const r of knownRows ?? []) {
    if (r.original_path) known.add(r.original_path);
    if (r.sidecar_path) known.add(r.sidecar_path);
  }

  let objects: ListedObject[];
  try {
    objects = await listOriginals();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  const stored: StoredObject[] = objects.map((o) => ({
    ...o,
    has_row: known.has(o.name),
  }));
  const existingOriginals = new Set(objects.map((o) => o.name));

  const repairRows = (rows ?? []) as RepairRow[];
  const planned = planSweep(repairRows, stored, existingOriginals, now, {
    transcode: transcodeEnabled(),
    orphanMs,
  });
  // Transcodes are the only slow actions: run them last so everything cheap
  // always completes, and stop starting new ones once the budget is spent.
  const plan = [
    ...planned.filter((a) => a.action !== 'transcodeVideo'),
    ...planned.filter((a) => a.action === 'transcodeVideo'),
  ];

  const rowsById = new Map(repairRows.map((r) => [r.id, r]));
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  for (const a of plan) {
    const target = 'photoId' in a ? `photoId=${a.photoId}` : `path=${a.path}`;
    if (a.action === 'transcodeVideo' && Date.now() - now > TRANSCODE_BUDGET_MS) {
      counts.transcodeDeferred = (counts.transcodeDeferred ?? 0) + 1;
      console.info(`photos.repair action=transcodeDeferred ${target}`);
      continue;
    }
    try {
      const counted = await execute(a, rowsById);
      counts[counted] = (counts[counted] ?? 0) + 1;
      console.info(`photos.repair action=${counted} ${target} ok`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${a.action}: ${msg}`);
      console.error(`photos.repair action=${a.action} ${target} err=${msg}`);
    }
  }

  return NextResponse.json({ counts, errors, planned: plan.length });
}

export const GET = run; // Vercel cron
export const POST = run; // manual runs
