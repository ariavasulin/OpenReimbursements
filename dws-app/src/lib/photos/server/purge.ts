import 'server-only';
import type { PhotoActor } from './authority';
import { photoRpc } from './http';
import { removeConfirmed } from '../repair/remove';

/** Photos read per round. */
const PAGE = 100;

export interface PurgeProgress {
  /** Photo rows deleted in this call, with all their files. */
  purged: number;
  /** Photos still waiting, to be finished by calling again. */
  remaining: number;
  /** Photos that failed this time (a Storage error); they stay waiting. */
  failed: number;
}

/**
 * Remove photos already marked by photo_purge_request, the same way the daily
 * repair sweep purges expired trash: SQL fences each path before the Storage
 * delete, Storage is checked for the object's absence, and only then is the row
 * deleted. Stops at `deadline` (ms since epoch) or when a round makes no
 * progress, and reports what is left, so the caller can simply call again.
 */
export async function purgeMarkedPhotos(actor: PhotoActor, deadline: number): Promise<PurgeProgress> {
  const progress: PurgeProgress = { purged: 0, remaining: 0, failed: 0 };
  const failedIds = new Set<string>();
  for (;;) {
    const pending = (await photoRpc(actor, 'photo_purge_pending', { p_actor: actor.actorId, p_limit: PAGE }) as
      Array<{ id: string; paths: string[] }>).filter(row => !failedIds.has(row.id));
    if (pending.length === 0) break;
    let finished = 0;
    for (const row of pending) {
      if (Date.now() > deadline) break;
      try {
        for (const path of row.paths) {
          if (await photoRpc(actor, 'photo_purge_authorize_delete', { p_actor: actor.actorId, p_path: path, p_photo_id: row.id })) {
            await removeConfirmed(actor.db, path);
          }
        }
        if (await photoRpc(actor, 'photo_purge_finish', { p_actor: actor.actorId, p_photo_id: row.id })) finished++;
        else failedIds.add(row.id);
      } catch (error) {
        console.error('photos.purge', row.id, error instanceof Error ? error.message : error);
        failedIds.add(row.id);
      }
    }
    progress.purged += finished;
    if (finished === 0 || Date.now() > deadline) break;
  }
  progress.failed = failedIds.size;
  const left = await photoRpc(actor, 'photo_purge_pending', { p_actor: actor.actorId, p_limit: 500 }) as unknown[];
  progress.remaining = left.length;
  return progress;
}
