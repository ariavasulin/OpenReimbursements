import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { beginUpload } from '@/lib/photos/server/uploads';

/** Attempt, lease, claim and original check for one upload, in one round trip (see beginUpload). */
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    return photoJson(await beginUpload(actor, await readPhotoJson(request)));
  });
}
