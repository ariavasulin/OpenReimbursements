import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute } from '@/lib/photos/server/http';
import { readPhotoOwnership } from '@/lib/photos/server/reads';
import { mayTrash } from '@/lib/photos/server/actions';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request);
    const photo = await readPhotoOwnership(actor, (await context.params).id);
    return photoJson({
      photo_id: photo.id, job_id: photo.job_id, uploader_id: photo.uploader_id,
      deleted_at: photo.deleted_at, purge_after: photo.purge_after, duplicate_of: photo.duplicate_of,
      // SQL photo_can_trash is the authority; this mirrors it. Anyone may restore; only retention limits it.
      can_trash: mayTrash(actor, photo),
      can_restore: Boolean(photo.deleted_at && Date.parse(photo.purge_after) > Date.now()),
    });
  });
}
