// Who may delete what in DWS Photos. The database is the authority:
// public.photo_can_trash and the photo-admin checks in
// 20261012182335_photo_admin_and_trash_rule.sql. This copy lets the screens offer
// only controls that will work, and the server uses it too: a trash list stops at
// a photo it refuses (server/actions.ts), the single-photo DELETE refuses early,
// and the ownership route answers can_trash with it. A change to the rule in SQL
// must be made here too.

/** How long after uploading a photo its uploader may still trash it. */
export const OWN_UPLOAD_TRASH_DAYS = 30;

/** The signed-in person, as GET /api/photos/actor reports them. */
export interface PhotoPermissions {
  user_id: string;
  photo_admin: boolean;
}

/** Plain words for a photo someone may not trash. */
export const TRASH_RULE_MESSAGE = `You can only delete photos you uploaded in the last ${OWN_UPLOAD_TRASH_DAYS} days.`;

/** May this person move this photo to Trash? An admin, or its uploader within 30 days of the upload. */
export function canTrashPhoto(
  actor: PhotoPermissions | null | undefined,
  photo: { uploader_id: string; created_at: string },
  now = Date.now(),
): boolean {
  if (!actor) return false;
  if (actor.photo_admin) return true;
  const uploaded = Date.parse(photo.created_at);
  return photo.uploader_id === actor.user_id && Number.isFinite(uploaded) &&
    uploaded > now - OWN_UPLOAD_TRASH_DAYS * 86_400_000;
}

/** May this person delete this album? An admin, or whoever made it. */
export function canDeleteAlbum(actor: PhotoPermissions | null | undefined, album: { created_by?: string | null }): boolean {
  return isPhotoAdmin(actor) || Boolean(actor && album.created_by && album.created_by === actor.user_id);
}

/** Delete forever, Empty trash, and project Delete: photo admins only. */
export function isPhotoAdmin(actor: PhotoPermissions | null | undefined): boolean {
  return actor?.photo_admin === true;
}
