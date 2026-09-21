import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { photoId, requirePhotoReader } from '@/lib/photos/server/reads';

interface RouteContext { params: Promise<{ id: string }> }

// GET /api/photo-albums/[id] — one live album for its page: { album: { id, name,
// photo_count, created_at } }. Read through the employee's own session, like the
// album list: a deleted or unknown album is hidden by its row rule and answers 404,
// and the membership rows of trashed photos are hidden too, so the count is of
// active photos only.
export async function GET(_request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const session = await requirePhotoReader(), id = photoId((await context.params).id);
    const [album, members] = await Promise.all([
      session.from('albums').select('id,name,created_at').eq('id', id).is('deleted_at', null).maybeSingle(),
      session.from('album_photos').select('photo_id', { count: 'exact', head: true }).eq('album_id', id),
    ]);
    if (album.error) throwPhotoDatabaseError(album.error);
    if (members.error) throwPhotoDatabaseError(members.error);
    if (!album.data) throw new PhotoApiError('not_found');
    return photoJson({ success: true, album: { ...album.data, photo_count: members.count ?? 0 } });
  });
}

// Any signed-in employee may rename, delete, and restore any album (photo-albums
// Decision 7). Every response is { album }, the full row including deleted_at.

// PATCH /api/photo-albums/[id] { name }               — rename a live album.
// PATCH /api/photo-albums/[id] { action: 'restore' }  — bring a deleted album back,
//       whole, within 30 days of its deletion; after that it is a 409 conflict.
export async function PATCH(request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const id = photoId((await context.params).id), body = await readPhotoJson(request);
    if ('action' in body) {
      onlyKeys(body, ['action']);
      if (body.action !== 'restore') throw new PhotoApiError('invalid_input');
      return photoJson(await photoRpc(actor, 'photo_restore_album', { p_actor: actor.actorId, p_album: id }));
    }
    onlyKeys(body, ['name']);
    if (typeof body.name !== 'string') throw new PhotoApiError('invalid_input');
    return photoJson(await photoRpc(actor, 'photo_rename_album', { p_actor: actor.actorId, p_album: id, p_name: body.name }));
  });
}

// DELETE /api/photo-albums/[id] — delete the album. No photo is deleted, and the
// album keeps its photos so a restore brings it back whole. Repeating it is safe
// and does not restart the 30 days.
export async function DELETE(request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const id = photoId((await context.params).id);
    return photoJson(await photoRpc(actor, 'photo_delete_album', { p_actor: actor.actorId, p_album: id }));
  });
}
