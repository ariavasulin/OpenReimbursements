import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, readPhotoJson, photoRpc } from '@/lib/photos/server/http';
import { uploadRpcArgs } from '@/lib/photos/server/uploads';
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (body.status !== 'retryable_failed' && body.status !== 'cancelled') throw new PhotoApiError('invalid_input');
    // Persist fixed client error categories, never arbitrary exception text.
    const allowed = ['upload_failed', 'claim_failed', 'lease_lost', 'cancelled', 'finalize_failed'];
    if (body.error_code !== undefined && !allowed.includes(body.error_code as string)) throw new PhotoApiError('invalid_input');
    const result = await photoRpc(actor, 'photo_release_upload', { ...uploadRpcArgs(actor, body, true),
      p_status: body.status, p_error_code: body.error_code ?? null });
    return photoJson(result ?? { status: body.status });
  });
}
