import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { MAX_ARRANGE_PHOTOS } from '@/lib/photos/apiShared';

interface RouteContext { params: Promise<{ id: string }> }

/** 2,000 UUIDs are about 78 KB of JSON. */
const ORDER_BODY_BYTES = 96 * 1024;

// PATCH /api/photo-albums/[id]/order — the album's order, the same for everyone.
//   { photo_ids: [...] }     the whole album in its new order: exactly its active
//                            photos, each once, at most 2,000 (400 otherwise). The
//                            album then shows this order (sort_mode 'custom').
//   { sort_mode: 'date' }    back to newest first. The saved order is kept, so
//                            saving it again restores it.
// Returns { sort_mode } (and `arranged`, the count, after a save). Any signed-in
// employee may arrange any album; a deleted or unknown album is 404.
export async function PATCH(request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const id = photoId((await context.params).id), body = await readPhotoJson(request, ORDER_BODY_BYTES);
    let photoIds: string[] | null;
    if ('sort_mode' in body) {
      onlyKeys(body, ['sort_mode']);
      if (body.sort_mode !== 'date') throw new PhotoApiError('invalid_input');
      photoIds = null;
    } else {
      onlyKeys(body, ['photo_ids']);
      const ids = body.photo_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ARRANGE_PHOTOS) throw new PhotoApiError('invalid_input');
      photoIds = ids.map(photoId);
    }
    return photoJson(await photoRpc(actor, 'photo_album_reorder', { p_actor: actor.actorId, p_album: id, p_photo_ids: photoIds }));
  });
}
