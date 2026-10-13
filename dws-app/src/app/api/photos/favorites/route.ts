import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';
import { BULK_BODY_BYTES, bulkPhotoIds } from '@/lib/photos/server/reads';

// POST /api/photos/favorites { photo_ids: [1-500 ids], on: boolean }
// The signed-in employee's own favorites: add (on) or remove. Personal: nobody
// else's favorites change, and nobody else sees these. Returns { updated }: with
// `on`, how many of the photos are now favorites (trashed or unknown ids are not);
// without, how many favorites came off.
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request, BULK_BODY_BYTES);
    onlyKeys(body, ['photo_ids', 'on']);
    if (typeof body.on !== 'boolean') throw new PhotoApiError('invalid_input');
    return photoJson(await photoRpc(actor, 'photo_favorite', {
      p_actor: actor.actorId, p_photo_ids: bulkPhotoIds(body.photo_ids), p_on: body.on,
    }));
  });
}
