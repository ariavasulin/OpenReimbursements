import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';
import { BULK_BODY_BYTES, bulkPhotoIds, photoId } from '@/lib/photos/server/reads';

interface RouteContext { params: Promise<{ id: string }> }

async function change(request: Request, context: RouteContext, rpc: 'photo_album_add' | 'photo_album_remove') {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const id = photoId((await context.params).id), body = await readPhotoJson(request, BULK_BODY_BYTES);
    onlyKeys(body, ['photo_ids']);
    return photoJson(await photoRpc(actor, rpc, { p_actor: actor.actorId, p_album: id, p_photo_ids: bulkPhotoIds(body.photo_ids) }));
  });
}

// Both take { photo_ids: [1-500 ids] } and are safe to repeat. Only active photos
// count: a trashed or unknown id is reported, never an error for the rest.

// POST /api/photo-albums/[id]/photos — add. Returns { added, already, missing }.
export async function POST(request: Request, context: RouteContext) {
  return change(request, context, 'photo_album_add');
}

// DELETE /api/photo-albums/[id]/photos — remove from the album; the photos
// themselves are untouched. Returns { removed }.
export async function DELETE(request: Request, context: RouteContext) {
  return change(request, context, 'photo_album_remove');
}
