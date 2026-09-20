import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deletionPaths } from '../apiShared';
import { WorkBudget, DeadlineExceeded } from './deadline';
import { mediaExecutor, type CountKey } from './executor';
import { planSweep, ORPHAN_MS, type RepairRow, type Action } from './sweep';
import { ENABLED } from './transcode';
import type { PathRow } from './known-paths';

const PAGE = 100;
const MAX_PURGE = 500;
const MAX_ERROR_SAMPLES = 50;
const MAX_ERROR_LENGTH = 1_000;
type Cursor = { after?: string } | null;
type Progress = { lease_generation: number; photo_cursor: Cursor; storage_cursor: Cursor };
export type RepairReport = {
  counts: Partial<Record<CountKey, number>>; errors: string[]; error_count: number; planned: number;
  purged: number; purge_failed: number; purge_backlog: number | null;
  oldest_due_at: string | null; work_deferred: number;
};
export function emptyReport(): RepairReport {
  return { counts: {}, errors: [], error_count: 0, planned: 0, purged: 0, purge_failed: 0,
    purge_backlog: null, oldest_due_at: null, work_deferred: 0 };
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** A completed HTTP delete may contain only a subset of requested names (or
 * no names for already absent objects). Never treat its data array as proof:
 * verify this exact object is absent using Storage HEAD before dropping a row. */
export async function removeConfirmed(admin: SupabaseClient, objectPath: string) {
  const removed = await admin.storage.from('photos').remove([objectPath]);
  if (removed.error) throw new Error(`remove ${objectPath}: ${removed.error.message}`);
  if ((await admin.storage.from('photos').exists(objectPath)).data) {
    throw new Error(`remove ${objectPath}: object remains after delete`);
  }
}

/** Bounded keyset pages are work discovery only. SQL authorizes each deletion
 * against current owners and durably fences future owners before Storage I/O. */
export async function runRepair(admin: SupabaseClient, budget: WorkBudget, options: {
  orphanMs?: number;
  executeMedia?: (actions: Action[], row: RepairRow, count: (key: CountKey) => void) => Promise<void>;
  // Separate reserved cleanup client: only backlog and lease release after work stops.
  cleanupAdmin?: SupabaseClient;
} = {}): Promise<{ report: RepairReport; status: number }> {
  const report = emptyReport();
  const holder = randomUUID();
  let progress: Progress | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | undefined;
  const cleanup = options.cleanupAdmin ?? admin;
  const count = (key: CountKey) => { report.counts[key] = (report.counts[key] ?? 0) + 1; };
  const rpc = async <T>(name: string, args: Record<string, unknown> = {}, client = admin): Promise<T> => {
    const call = client.rpc(name, { p_holder: holder, ...(progress ? { p_generation: progress.lease_generation } : {}), ...args });
    // Purge needs path metadata only; never return 500 photos' tags, warnings,
    // or other library fields just to delete their recorded objects.
    const result = await (name === 'photo_repair_claim_purge'
      ? call.select('id,original_path,sidecar_path,thumb_path,preview_path,playback_path') : call);
    if (result.error) {
      const error = new Error(`${name}: ${result.error.message}`);
      if (['stale_lease', 'photo_gate_closed'].includes(result.error.message)) budget.cancel(error);
      throw error;
    }
    return result.data as T;
  };
  const checkpoint = () => rpc('photo_repair_checkpoint', {
    p_photo_cursor: progress!.photo_cursor, p_storage_cursor: progress!.storage_cursor,
  });
  const cancellation = (error: unknown) => {
    try { budget.check(); } catch (cancelled) { return cancelled; }
    return error;
  };
  const record = (where: string, error: unknown) => {
    report.error_count++;
    if (report.errors.length < MAX_ERROR_SAMPLES) report.errors.push(`${where}: ${message(error)}`.slice(0, MAX_ERROR_LENGTH));
  };
  const media = options.executeMedia ?? mediaExecutor(admin, budget);
  try {
    budget.check();
    progress = await rpc<Progress | null>('photo_repair_acquire');
    if (!progress) {
      report.work_deferred = 1;
      return { report, status: 200 };
    }
    heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = rpc('photo_repair_renew').then(() => {}).catch(error => {
        record('lease renewal', error);
        budget.cancel(error instanceof Error ? error : new Error(message(error)));
      }).finally(() => { renewal = undefined; });
    }, 30_000);
    const initial = await rpc<{ purge_backlog: number; oldest_due_at: string | null }>('photo_repair_backlog');
    Object.assign(report, initial);

    // Claim one bounded batch once; the SQL ordering drains expired duplicate
    // references first. Reclaiming after process death is safe and idempotent.
    const due = await rpc<Array<PathRow & { id: string }>>('photo_repair_claim_purge', { p_limit: MAX_PURGE });
    for (let i = 0; i < due.length; i++) {
      const row = due[i];
      try {
        budget.check();
        for (const objectPath of new Set(deletionPaths(row))) {
          budget.check();
          if (await rpc<boolean>('photo_repair_authorize_delete', { p_path: objectPath, p_photo_id: row.id })) {
            await removeConfirmed(admin, objectPath);
          }
        }
        if (await rpc<boolean>('photo_repair_finish_purge', { p_photo_id: row.id })) report.purged++;
        else report.work_deferred++;
      } catch (caught) {
        const error = cancellation(caught);
        if (error instanceof DeadlineExceeded) { report.work_deferred += due.length - i; throw error; }
        budget.check();
        report.purge_failed++;
        record(`purge ${row.id}`, error);
      }
    }

    // Alternate bounded photo/object pages, so a large corpus of either kind
    // cannot starve the other. Persist each processed item, never a global set.
    let photosDone = false;
    let objectsDone = false;
    while (!photosDone || !objectsDone) {
      budget.check();
      if (!photosDone) {
        let query = admin.from('photos').select('id,uploader_id,kind,mime_type,original_path,original_bytes,thumb_path,playback_path,playback_skipped_reason,poster_skipped_reason,created_at')
          .is('deleted_at', null).or('and(thumb_path.is.null,poster_skipped_reason.is.null),and(kind.eq.video,playback_path.is.null,playback_skipped_reason.is.null)')
          .order('id').limit(PAGE);
        if (progress.photo_cursor?.after) query = query.gt('id', progress.photo_cursor.after);
        const result = await query;
        if (result.error) throw new Error(`photo page: ${result.error.message}`);
        const rows = result.data as RepairRow[];
        for (const row of rows) {
          budget.check();
          try {
            // A partial bucket page never proves absence. The actual Storage
            // HEAD is followed by another database-side absence check on delete.
            const exists = (await admin.storage.from('photos').exists(row.original_path)).data;
            const actions = planSweep([row], exists ? [{ name: row.original_path, created_at: row.created_at, has_row: true }] : [], Date.now(), { transcode: ENABLED() });
            report.planned += actions.length;
            if (actions.some(a => a.action === 'deleteDeadRow')) {
              count(await rpc<boolean>('photo_repair_delete_dead', { p_photo_id: row.id, p_expected_original: row.original_path }) ? 'deleteDeadRow' : 'deadRowDeleteSkipped');
            } else await media(actions, row, count);
          } catch (caught) {
            const error = cancellation(caught);
            if (error instanceof DeadlineExceeded) {
              report.work_deferred++;
              if (row.kind === 'video' && !row.playback_path && !row.playback_skipped_reason && ENABLED()) count('transcodeDeferred');
              throw error;
            }
            budget.check();
            record(`repair ${row.id}`, error);
          }
          progress.photo_cursor = { after: row.id };
          await checkpoint();
        }
        if (rows.length < PAGE) {
          photosDone = true;
          progress.photo_cursor = null;
          await checkpoint();
        }
      }
      budget.check();
      if (!objectsDone) {
        const objects = await rpc<Array<{ name: string; created_at: string; updated_at: string }>>('photo_repair_storage_page', { p_after: progress.storage_cursor?.after ?? null, p_limit: PAGE });
        for (const object of objects) {
          budget.check();
          try {
            const age = Date.now() - Math.max(Date.parse(object.created_at), Date.parse(object.updated_at || object.created_at));
            if (age > (options.orphanMs ?? ORPHAN_MS)) {
              if (await rpc<boolean>('photo_repair_authorize_delete', { p_path: object.name })) {
                report.planned++;
                await removeConfirmed(admin, object.name);
                count('deleteOrphanObject');
              }
            }
          } catch (caught) {
            const error = cancellation(caught);
            if (error instanceof DeadlineExceeded) { report.work_deferred++; throw error; }
            budget.check();
            record(`orphan ${object.name}`, error);
          }
          progress.storage_cursor = { after: object.name };
          await checkpoint();
        }
        if (objects.length < PAGE) {
          objectsDone = true;
          progress.storage_cursor = null;
          await checkpoint();
        }
      }
    }
  } catch (error) {
    error = cancellation(error);
    if (error instanceof DeadlineExceeded) report.work_deferred = Math.max(1, report.work_deferred);
    else record('repair', error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (renewal) await renewal;
    if (progress) {
      try {
        Object.assign(report, await rpc('photo_repair_backlog', {}, cleanup));
      } catch (error) { record('backlog', error); }
      try {
        await rpc('photo_repair_checkpoint', { p_photo_cursor: progress.photo_cursor, p_storage_cursor: progress.storage_cursor, p_release: true }, cleanup);
      } catch (error) { record('lease release', error); }
    }
  }
  return { report, status: report.error_count ? 500 : 200 };
}
