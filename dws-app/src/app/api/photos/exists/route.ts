import { isSha256 } from '@/lib/photos/apiShared';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute } from '@/lib/photos/server/http';
import { describeUploadOutcome, uploadRpc } from '@/lib/photos/server/uploads';

/** Global intentional digest read. Claims, rather than this hint, authorize transfers. */
export async function GET(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request);
    const sha = new URL(request.url).searchParams.get('sha');
    if (!isSha256(sha)) throw new PhotoApiError('invalid_input');
    const outcome = await uploadRpc(actor, 'photo_canonical_outcome', { p_digest: sha });
    return photoJson(outcome ? await describeUploadOutcome(actor, outcome) : { status: 'not_found' });
  });
}
