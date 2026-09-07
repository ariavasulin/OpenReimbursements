import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson, photoRpc } from '@/lib/photos/server/http';
import { describeUploadOutcome, uploadRpcArgs } from '@/lib/photos/server/uploads';
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    const value = await photoRpc(actor, 'photo_renew_upload', uploadRpcArgs(actor, body, true, true));
    return photoJson(await describeUploadOutcome(actor, value));
  });
}
