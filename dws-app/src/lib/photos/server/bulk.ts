import 'server-only';
import { MAX_ACTION_RUN_PHOTOS } from '../chunks';
import { mayTrash, onlyKeys } from './actions';
import type { PhotoActor } from './authority';
import { PhotoApiError, photoRpc, throwPhotoDatabaseError } from './http';
import { photoId } from './reads';

// Trash or restore a selection in one request (POST /api/photos/bulk), instead
// of the browser driving the batch one step at a time: create the batch,
// materialize it, approve it, apply it, all here, next to the database. The
// steps are the same SQL functions the confirm page uses, so the rules (who may
// trash what) and the audit trail (photo_action_batches and _items) stay in SQL.
// The browser sends a big selection in slices of MAX_ACTION_RUN_PHOTOS, which
// keeps each request well inside the function time limit.

/** photo_materialize_action and photo_execute_action take at most 100 photos a call. */
export const SQL_STEP = 100;

/** 1,000 UUIDs are about 40 KB of JSON. */
export const RUN_BODY_BYTES = 64 * 1024;

export type BulkAction = 'trash' | 'restore';

export interface BulkActionResult {
  /** The batch that recorded this slice; null when nothing in it could be changed. */
  batch_id: string | null;
  /** The photos the action reached. */
  photo_ids: string[];
  /** Sent but left out before the batch: gone, or (trash) not this person's to delete. */
  left_out: number;
  /** In the batch, but changed by someone else before it applied (SQL's per-photo conflict). */
  failed: number;
}

/** The request body: `{action, photo_ids}`, 1 to MAX_ACTION_RUN_PHOTOS ids, each counted once. */
export function bulkActionInput(body: Record<string, unknown>): { action: BulkAction; ids: string[] } {
  onlyKeys(body, ['action', 'photo_ids']);
  if (body.action !== 'trash' && body.action !== 'restore') throw new PhotoApiError('invalid_input');
  const ids = body.photo_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ACTION_RUN_PHOTOS) throw new PhotoApiError('invalid_input');
  return { action: body.action, ids: [...new Set(ids.map(photoId))] };
}

/** `items` in runs of at most `size`, in order. */
export function steps<T>(items: readonly T[], size = SQL_STEP): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

type Row = { id: string; uploader_id: string; created_at: string; deleted_at: string | null };

/**
 * Sort the ids, in their order, into what the batch takes and what is left out.
 * Left out: gone, or for Trash one this person may not delete. A photo SQL
 * would refuse is left out here rather than failing the whole slice; SQL still
 * checks every one again. A photo already in Trash is neither: Trash has
 * nothing to do to it, and its Undo must not bring it back. One read per 100
 * ids (a long `in` list makes a long URL), all at once.
 */
async function sortIds(actor: PhotoActor, action: BulkAction, ids: readonly string[]) {
  const reads = await Promise.all(
    steps(ids).map(chunk => actor.db.from('photos').select('id,uploader_id,created_at,deleted_at').in('id', chunk)),
  );
  const rows = new Map<string, Row>();
  for (const { data, error } of reads) {
    if (error) throwPhotoDatabaseError(error);
    for (const row of (data ?? []) as Row[]) rows.set(row.id, row);
  }
  const targets: string[] = [];
  let leftOut = 0;
  for (const id of ids) {
    const row = rows.get(id);
    if (!row || (action === 'trash' && !mayTrash(actor, row))) leftOut += 1;
    else if (action !== 'trash' || row.deleted_at === null) targets.push(id);
  }
  return { targets, leftOut };
}

export async function runBulkAction(actor: PhotoActor, action: BulkAction, ids: readonly string[]): Promise<BulkActionResult> {
  const { targets, leftOut: left_out } = await sortIds(actor, action, ids);
  if (targets.length === 0) return { batch_id: null, photo_ids: [], left_out, failed: 0 };

  // The same row the confirm page's draft makes (createAction), naming exactly the targets.
  const { data, error } = await actor.db.from('photo_action_batches').insert({
    created_by: actor.actorId, origin: 'ordinary', action,
    selector: { photos: targets.map(photo_id => ({ photo_id })) }, destination_job_id: null,
  }).select('id').single();
  if (error) throwPhotoDatabaseError(error);
  const batchId = (data as { id: string }).id;

  // Materialize: the cursor is the selector index reached, as materializeAction keeps it.
  let cursor: string | null = null;
  let reached = 0;
  for (const chunk of steps(targets)) {
    reached += chunk.length;
    const next = String(reached);
    await photoRpc(actor, 'photo_materialize_action', {
      p_actor: actor.actorId, p_batch_id: batchId, p_cursor: cursor,
      p_ids: chunk, p_next_cursor: next, p_complete: reached === targets.length,
    });
    cursor = next;
  }
  await photoRpc(actor, 'photo_approve_action', { p_actor: actor.actorId, p_batch_id: batchId });

  // Apply what the batch holds, not what was asked for: restoring a legacy copy
  // puts its original in the batch instead (photo_materialize_action).
  const items = await actor.db.from('photo_action_items').select('photo_id')
    .eq('batch_id', batchId).order('photo_id').range(0, targets.length - 1);
  if (items.error) throwPhotoDatabaseError(items.error);
  const held = ((items.data ?? []) as { photo_id: string }[]).map(item => item.photo_id);

  // Each call locks the batch row, so they go one after another.
  const applied: string[] = [];
  let failed = 0;
  for (const chunk of steps(held)) {
    const outcomes = (await photoRpc(actor, 'photo_execute_action', {
      p_actor: actor.actorId, p_batch_id: batchId, p_photo_ids: chunk,
    })) as { status: string; photo_id: string }[];
    for (const outcome of outcomes) {
      if (outcome.status === 'applied') applied.push(outcome.photo_id);
      else failed += 1;
    }
  }
  return { batch_id: batchId, photo_ids: applied, left_out, failed };
}
