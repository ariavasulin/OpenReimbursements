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
  derivedKeys,
  planSweep,
  type Action,
  type RepairRow,
} from '@/lib/photos/repair/sweep';
import {
  PATH_COLUMNS,
  knownPaths,
  markOwnership,
  type ListedObject,
  type PathRow,
} from '@/lib/photos/repair/known-paths';
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
// one failure lands in `errors` and never aborts the rest. A run that ends
// with any error responds 500 so the cron shows red.
//
// `?olderThan=<ms>` (manual runs) overrides the 24 h orphan age for drills.

export const maxDuration = 300;

const BUCKET = 'photos';
const PAGE = 1000;
/** Stop starting new transcodes after this much wall time. */
const TRANSCODE_BUDGET_MS = 240 * 1000;
/** Directory listings in flight at once while walking the bucket. */
const LIST_CONCURRENCY = 8;
/** Prefixes that hold photo objects, walked one after the other so the whole
 * listing stays inside LIST_CONCURRENCY. */
const ROOTS = ['originals', 'derived'];

/** Counter keys: every planned action, plus the outcomes the executor can
 * report in place of one (downgrades, the budget deferral, and a destructive
 * action its confirmation read cancelled). */
type CountKey =
  | Action['action']
  | 'playbackSkipped'
  | 'transcodeDeferred'
  | 'orphanDeleteSkipped'
  | 'deadRowDeleteSkipped';

/** Walks a photos query page by page. PostgREST caps an un-ranged response at
 * its configured row limit (1000 by default) and says nothing about it, so an
 * unpaged read of a table past that size is silently partial — and a partial
 * known-paths read makes every object of an unlisted row read as an orphan.
 * Ordered by id so the pages tile the table instead of overlapping.
 *
 * Rows come back as T on the caller's word — a select list built from a const
 * array isn't a literal, so PostgREST's row type can't be inferred from it. */
async function selectAllPages<T>(
  page: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
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

/** Lists each prefix, at most LIST_CONCURRENCY requests in flight. */
async function listDirs(prefixes: string[]) {
  const out: { prefix: string; entries: Awaited<ReturnType<typeof listDir>> }[] = [];
  for (let i = 0; i < prefixes.length; i += LIST_CONCURRENCY) {
    out.push(
      ...(await Promise.all(
        prefixes
          .slice(i, i + LIST_CONCURRENCY)
          .map(async (prefix) => ({ prefix, entries: await listDir(prefix) }))
      ))
    );
  }
  return out;
}

/** Every object under `root`, covering both layouts the bucket uses:
 * originals/{uid}/{photoId}/{file} and derived/{uid}/{file}. Files are
 * collected at both depths — under derived/ the uid level holds the real
 * renditions, and under originals/ it only ever holds strays, which the
 * orphan sweep wants collected anyway. */
async function listObjects(root: string): Promise<ListedObject[]> {
  const out: ListedObject[] = [];

  const uidPrefixes = (await listDir(root))
    .filter((e) => e.id === null) // stray file at the top level — ignore
    .map((e) => `${root}/${e.name}`);

  const photoPrefixes: string[] = [];
  for (const { prefix, entries } of await listDirs(uidPrefixes)) {
    for (const entry of entries) {
      if (entry.id === null) {
        photoPrefixes.push(`${prefix}/${entry.name}`);
      } else {
        out.push({ name: `${prefix}/${entry.name}`, created_at: entry.created_at });
      }
    }
  }

  for (const { prefix, entries } of await listDirs(photoPrefixes)) {
    for (const file of entries) {
      if (file.id === null) continue;
      out.push({ name: `${prefix}/${file.name}`, created_at: file.created_at });
    }
  }

  return out;
}

/** Quotes a storage path for a PostgREST or() filter: an uploaded filename
 * can hold commas, parens, and quotes, all of them or() syntax. */
function quoteFilter(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Does any photos row still point at this exact object? The bulk listing is
 * a snapshot: a finalize that landed mid-sweep makes a live object look
 * row-less, and deleting a storage object is not reversible. */
async function isReferenced(objectPath: string): Promise<boolean> {
  const value = quoteFilter(objectPath);
  const { data, error } = await supabaseAdmin
    .from('photos')
    .select('id')
    .or(PATH_COLUMNS.map((column) => `${column}.eq.${value}`).join(','))
    .limit(1);
  if (error) throw new Error(`confirm orphan ${objectPath}: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Is this one object really in storage? A targeted HEAD, not the bulk walk:
 * a concurrent delete shifts list offsets mid-scan and can drop a live object
 * out of the listing, after which its row looks dead. (A clean miss comes
 * back as `data: false` with an error set; anything else exists() throws.) */
async function objectExists(objectPath: string): Promise<boolean> {
  const { data } = await supabaseAdmin.storage.from(BUCKET).exists(objectPath);
  return data;
}

async function markFileTile(photoId: string, reason: string) {
  const { error } = await supabaseAdmin
    .from('photos')
    .update({ kind: 'file' })
    .eq('id', photoId);
  if (error) throw new Error(`markFileTile ${photoId}: ${error.message}`);
  console.info(`photos.repair markFileTile photoId=${photoId} reason=${reason}`);
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

/** Streams the stored original into `dir` and reads its duration — the shared
 * prefix of both video actions, so a row that needs a poster AND a rendition
 * pays for the download and the probe once. (The bucket is public, so a plain
 * fetch streams; supabase-js download() would buffer the whole clip.) */
async function fetchAndProbe(row: RepairRow, dir: string) {
  const input = path.join(dir, `input${path.extname(row.original_path) || '.bin'}`);
  const { data } = supabaseAdmin.storage
    .from(BUCKET)
    .getPublicUrl(row.original_path);
  const res = await fetch(data.publicUrl);
  if (!res.ok || !res.body) {
    throw new Error(`download ${row.original_path}: ${res.status}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
    createWriteStream(input)
  );
  const { durationSecs } = await probe(input);
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
  await poster(input, seek, outputs);
  await Promise.all(
    outputs.map(async (out) => {
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(out.key, await readFile(out.path), {
          contentType: 'image/webp',
          upsert: true,
        });
      if (error) throw new Error(`upload ${out.key}: ${error.message}`);
    })
  );

  const { error } = await supabaseAdmin
    .from('photos')
    .update({
      thumb_path: keys.thumb,
      preview_path: keys.preview,
      duration_secs: durationSecs !== null && durationSecs > 0 ? durationSecs : null,
    })
    .eq('id', row.id);
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
  const bytes = row.original_bytes ?? (await stat(input)).size;
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
  const key = derivedKeys(row.uploader_id, row.id).playback;
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
}

interface VideoOpts {
  /** This row's poster is due too: produce both from the one download. */
  alsoPoster: boolean;
  /** Transcode budget spent — skip the rendition; the poster still runs. */
  deferTranscode: boolean;
}

/** Runs one action, calling `count` as each piece of work commits. Counting
 * as we go rather than on return is what keeps a paired poster's count when
 * the transcode behind it throws: the poster's row update has landed, and a
 * run that under-reports committed work can never reach `errors: []`. */
async function execute(
  a: Action,
  rowsById: Map<string, RepairRow>,
  video: VideoOpts,
  count: (key: CountKey) => void
): Promise<void> {
  const rowFor = (photoId: string): RepairRow => {
    const row = rowsById.get(photoId);
    if (!row) throw new Error(`no repair row for ${photoId}`);
    return row;
  };

  switch (a.action) {
    case 'fillImageDerivatives': {
      const result = await fillImageDerivatives(supabaseAdmin, rowFor(a.photoId));
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
        const row = rowFor(a.photoId);
        const { input, durationSecs } = await fetchAndProbe(row, dir);
        await writePoster(row, dir, input, durationSecs);
        count(a.action);
      });
    case 'transcodeVideo':
      return withTempDir(async (dir) => {
        const row = rowFor(a.photoId);
        const { input, durationSecs } = await fetchAndProbe(row, dir);
        if (video.alsoPoster) {
          await writePoster(row, dir, input, durationSecs);
          count('makeVideoPoster');
        }
        count(
          video.deferTranscode
            ? 'transcodeDeferred'
            : await writeRendition(row, dir, input, durationSecs)
        );
      });
    // A cancelled delete is counted, not raised — the next run replans it if
    // it was genuinely due.
    case 'deleteOrphanObject': {
      if (await isReferenced(a.path)) {
        count('orphanDeleteSkipped');
        return;
      }
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove([a.path]);
      if (error) throw new Error(`remove ${a.path}: ${error.message}`);
      count(a.action);
      return;
    }
    case 'deleteDeadRow': {
      if (await objectExists(rowFor(a.photoId).original_path)) {
        count('deadRowDeleteSkipped');
        return;
      }
      const { error } = await supabaseAdmin
        .from('photos')
        .delete()
        .eq('id', a.photoId);
      if (error) throw new Error(`delete row ${a.photoId}: ${error.message}`);
      count(a.action);
      return;
    }
  }
}

async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Absent means the default 24 h orphan age. Anything present must parse:
  // Number('') is 0, so a trailing `&olderThan` in a hand-typed curl would
  // otherwise coerce into the most destructive mode — delete every row-less
  // object right now — silently.
  const olderThanRaw = new URL(request.url).searchParams.get('olderThan');
  let orphanMs: number | undefined;
  if (olderThanRaw !== null) {
    const olderThan = Number(olderThanRaw);
    if (olderThanRaw.trim() === '' || !Number.isFinite(olderThan) || olderThan < 0) {
      return NextResponse.json(
        { error: `olderThan must be a non-negative number of ms, got "${olderThanRaw}"` },
        { status: 400 }
      );
    }
    orphanMs = olderThan;
  }

  const now = Date.now();

  // None of these three reads consumes another's result, so they overlap:
  //  - rows with a hole: a missing thumb, or a video missing its playback
  //    rendition. (Rows with playback_skipped_reason set still match — the
  //    planner drops them, so they never replan.)
  //  - every path some row points at, across all five path columns; anything
  //    stored and unlisted here is what the sweep deletes as an orphan.
  //  - everything actually stored under originals/ and derived/.
  // Any of the three failing takes the whole run down: a plan built on half
  // an inventory deletes objects and rows that were never orphaned.
  let repairRows: RepairRow[];
  let pathRows: PathRow[];
  let objects: ListedObject[];
  try {
    [repairRows, pathRows, objects] = await Promise.all([
      selectAllPages<RepairRow>((from, to) =>
        supabaseAdmin
          .from('photos')
          .select(
            'id, uploader_id, kind, mime_type, original_path, original_bytes, thumb_path, playback_path, playback_skipped_reason, created_at'
          )
          .or('thumb_path.is.null,and(kind.eq.video,playback_path.is.null)')
          .order('id')
          .range(from, to)
      ),
      selectAllPages<PathRow>((from, to) =>
        supabaseAdmin
          .from('photos')
          .select(PATH_COLUMNS.join(', '))
          .order('id')
          .range(from, to)
      ),
      (async () => {
        const found: ListedObject[] = [];
        for (const root of ROOTS) found.push(...(await listObjects(root)));
        return found;
      })(),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const stored = markOwnership(objects, knownPaths(pathRows));

  const planned = planSweep(repairRows, stored, now, {
    transcode: transcodeEnabled(),
    orphanMs,
  });

  // A video missing both its poster and its rendition is planned for two
  // actions off one row; the transcode entry does both from a single
  // download, so drop the standalone poster entry for those photos.
  const posterIds = new Set(
    planned.filter((a) => a.action === 'makeVideoPoster').map((a) => a.photoId)
  );
  const pairedIds = new Set(
    planned.flatMap((a) =>
      a.action === 'transcodeVideo' && posterIds.has(a.photoId) ? [a.photoId] : []
    )
  );
  // Transcodes are the only slow actions: run them last so everything cheap
  // always completes, and stop starting new ones once the budget is spent.
  const plan = [
    ...planned.filter(
      (a) =>
        a.action !== 'transcodeVideo' &&
        !(a.action === 'makeVideoPoster' && pairedIds.has(a.photoId))
    ),
    ...planned.filter((a) => a.action === 'transcodeVideo'),
  ];

  const rowsById = new Map(repairRows.map((r) => [r.id, r]));
  const counts: Partial<Record<CountKey, number>> = {};
  const errors: string[] = [];
  for (const a of plan) {
    const target = 'photoId' in a ? `photoId=${a.photoId}` : `path=${a.path}`;
    const alsoPoster = 'photoId' in a && pairedIds.has(a.photoId);
    const deferTranscode = Date.now() - now > TRANSCODE_BUDGET_MS;
    if (a.action === 'transcodeVideo' && deferTranscode && !alsoPoster) {
      counts.transcodeDeferred = (counts.transcodeDeferred ?? 0) + 1;
      console.info(`photos.repair action=transcodeDeferred ${target}`);
      continue;
    }
    const counted: CountKey[] = [];
    const count = (key: CountKey) => {
      counted.push(key);
      counts[key] = (counts[key] ?? 0) + 1;
    };
    try {
      await execute(a, rowsById, { alsoPoster, deferTranscode }, count);
      console.info(`photos.repair action=${counted.join('+')} ${target} ok`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${a.action}: ${msg}`);
      const committed = counted.length ? ` committed=${counted.join('+')}` : '';
      console.error(`photos.repair action=${a.action} ${target}${committed} err=${msg}`);
    }
  }

  // A run with any failed action must not read as a successful invocation:
  // Vercel scores the cron on the status code, and a green run where every
  // action failed is never retried and never noticed. The body keeps its
  // shape, so a manual run still shows the counts and the errors.
  return NextResponse.json(
    { counts, errors, planned: planned.length },
    { status: errors.length > 0 ? 500 : 200 }
  );
}

export const GET = run;
export const POST = run;
