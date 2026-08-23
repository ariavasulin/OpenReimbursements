import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import {
  planSweep,
  type Action,
  type RepairRow,
  type StoredObject,
} from '@/lib/photos/repair/sweep';
import { fillImageDerivatives } from '@/lib/photos/repair/transforms';

// GET/POST /api/photos/repair — the daily convergence sweep (Vercel cron
// issues GET with Authorization: Bearer $CRON_SECRET; POST is for manual
// runs with the same header). Plans with the pure planner in
// lib/photos/repair/sweep.ts, then executes action-by-action, each isolated:
// one failure lands in `errors` and never aborts the rest.
//
// Phase 5 scope: fill image derivatives via Supabase transforms, downgrade
// untransformable images to deliberate file tiles, delete >24h row-less
// objects and rows whose original never landed. Video poster/transcode
// actions are planned but no-op until the ffmpeg work (Phase 6).
//
// `?olderThan=<ms>` (manual runs) overrides the 24 h orphan age for drills.

export const maxDuration = 300;

const BUCKET = 'photos';
const PAGE = 1000;

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

/** Runs one action; returns the action name to count (fillImageDerivatives
 * downgrades to markFileTile when the transform endpoint refuses the file). */
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
    case 'makeVideoPoster':
    case 'transcodeVideo':
      // Phase 6 (ffmpeg) — planned so the counts show the backlog, no-op here.
      return a.action;
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

  // Rows with a derivative hole. (Phase 6 widens this to videos missing
  // playback_path once those columns exist.)
  const { data: rows, error: rowsError } = await supabaseAdmin
    .from('photos')
    .select(
      'id, uploader_id, kind, mime_type, original_path, original_bytes, thumb_path, created_at'
    )
    .is('thumb_path', null);
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
  const plan = planSweep(repairRows, stored, existingOriginals, now, {
    transcode: process.env.PHOTOS_TRANSCODE === '1',
    orphanMs,
  });

  const rowsById = new Map(repairRows.map((r) => [r.id, r]));
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  for (const a of plan) {
    const target = 'photoId' in a ? `photoId=${a.photoId}` : `path=${a.path}`;
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
