import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';

// PATCH /api/photo-jobs/[id] { name } — rename a project. The job number never changes.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (typeof body.name !== 'string') throw new PhotoApiError('invalid_input');
    return photoJson(await photoRpc(actor, 'photo_rename_job', {
      p_actor: actor.actorId, p_job_id: photoId((await params).id), p_name: body.name,
    }));
  });
}
