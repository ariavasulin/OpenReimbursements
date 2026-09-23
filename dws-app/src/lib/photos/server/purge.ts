import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PhotoActor } from './authority';
import { photoRpc, throwPhotoDatabaseError } from './http';
import { removeConfirmed } from '../repair/remove';

/** Photos read per round. */
const PAGE = 100;
/** Each database or Storage call gives up after this, so one hung call cannot
 * outlast the route and leave the request killed mid-photo. */
const CALL_MS = 15_000;

export interface PurgeProgress {
  /** Photo rows deleted in this call, with all their files. */
  purged: number;
  /** Photos still marked, to be finished by calling again. */
  remaining: number;
  /** Photos that failed this time (a Storage error); they stay marked. */
  failed: number;
}

/** A service-role client whose every request carries its own timeout. */
function timedClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.any([AbortSignal.timeout(CALL_MS), ...(init?.signal ? [init.signal] : [])]),
      }),
    },
  });
}

/**
 * Remove photos already marked by photo_purge_request, the same way the daily
 * repair sweep purges expired trash: SQL fences each path before the Storage
 * delete, Storage is checked for the object's absence, and only then is the row
 * deleted. Photos that fail are skipped for the rest of this call, so they never
 * hide the marked photos behind them. Stops at `deadline` (ms since epoch) or
 * when nothing is left to try, and reports what is left, so the caller can
 * simply call again.
 */
export async function purgeMarkedPhotos(actor: PhotoActor, deadline: number): Promise<PurgeProgress> {
  const timed: PhotoActor = { ...actor, db: timedClient() as PhotoActor['db'] };
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> =>
    await photoRpc(timed, name, { p_actor: actor.actorId, ...args }) as T;
  const progress: PurgeProgress = { purged: 0, remaining: 0, failed: 0 };
  const failedIds: string[] = [];
  while (Date.now() < deadline) {
    const pending = await rpc<Array<{ id: string; paths: string[] }>>('photo_purge_pending', { p_limit: PAGE, p_exclude: failedIds });
    if (pending.length === 0) break;
    for (const row of pending) {
      if (Date.now() > deadline) break;
      try {
        for (const path of row.paths) {
          if (await rpc<boolean>('photo_purge_authorize_delete', { p_path: path, p_photo_id: row.id })) {
            await removeConfirmed(timed.db, path);
          }
        }
        if (await rpc<boolean>('photo_purge_finish', { p_photo_id: row.id })) progress.purged++;
        else failedIds.push(row.id);
      } catch (error) {
        console.error('photos.purge', row.id, error instanceof Error ? error.message : error);
        failedIds.push(row.id);
      }
    }
  }
  progress.failed = failedIds.length;
  progress.remaining = await countMarkedPhotos(timed.db);
  return progress;
}

/** Photos marked for deletion forever whose files are not yet removed. */
export async function countMarkedPhotos(db: SupabaseClient): Promise<number> {
  const { count, error } = await db.from('photos').select('id', { count: 'exact', head: true })
    .not('deleted_at', 'is', null).not('purge_claimed_at', 'is', null);
  if (error) throwPhotoDatabaseError(error);
  return count ?? 0;
}
