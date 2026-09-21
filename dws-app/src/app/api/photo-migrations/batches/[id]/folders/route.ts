import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { readMigrationFolders } from '@/lib/photos/server/migrations';

/** Folder rows for import review: `?after=<id>&limit=<1-1000>`, in id order. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return photoRoute(async () => photoJson(await readMigrationFolders(await requirePhotoActor(request), photoId((await context.params).id), request)));
}
