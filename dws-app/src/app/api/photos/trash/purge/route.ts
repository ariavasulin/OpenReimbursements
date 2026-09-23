import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';
import { purgeMarkedPhotos } from '@/lib/photos/server/purge';
import { photoId } from '@/lib/photos/server/reads';

export const maxDuration = 60;
/** Leave headroom under maxDuration for the final count and the response. */
const WORK_MS = 45_000;
const MAX_IDS = 500;

const ids = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new PhotoApiError('invalid_input');
  return value.map(id => photoId(typeof id === 'string' ? id : ''));
};

/**
 * POST /api/photos/trash/purge — delete from Trash forever. Any signed-in employee.
 *   { photo_ids?, album_ids?, project_ids? }  the named items (they must be in Trash;
 *        a project takes every one of its trashed photos with it)
 *   { everything: true }                      empty the whole Trash
 *   {}                                        keep removing what is already marked
 * Marked photos leave Trash at once and cannot be restored. Their files are then
 * removed within this request's time; `remaining` above zero means call again
 * with {} to finish. Albums and projects are gone as soon as they are marked.
 */
export async function POST(request: Request) {
  return photoRoute(async () => {
    const started = Date.now();
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    onlyKeys(body, ['photo_ids', 'album_ids', 'project_ids', 'everything']);
    if (body.everything !== undefined && body.everything !== true) throw new PhotoApiError('invalid_input');
    const photos = ids(body.photo_ids), albums = ids(body.album_ids), projects = ids(body.project_ids);
    const everything = body.everything === true;
    let marked: { photos: number; albums: number; projects: number } = { photos: 0, albums: 0, projects: 0 };
    if (everything || photos.length + albums.length + projects.length > 0) {
      marked = await photoRpc(actor, 'photo_purge_request', {
        p_actor: actor.actorId, p_photo_ids: photos, p_album_ids: albums, p_job_ids: projects, p_everything: everything,
      });
    }
    const progress = await purgeMarkedPhotos(actor, started + WORK_MS);
    return photoJson({ success: true, marked, ...progress });
  });
}
