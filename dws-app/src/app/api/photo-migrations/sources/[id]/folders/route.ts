import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { updateMigrationFolders } from '@/lib/photos/server/migrations';

/**
 * One review edit on a picked folder's rows, while the import is still a draft.
 * Body: `{ folder, include_subfolders?, job_id?, tags?, album_name?, album_id? }`.
 * `folder` is the path under the picked folder ('' is the picked folder itself).
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    return photoJson(await updateMigrationFolders(actor, (await context.params).id, await readPhotoJson(request)));
  });
}
