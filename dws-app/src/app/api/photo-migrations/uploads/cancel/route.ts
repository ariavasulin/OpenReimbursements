import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, readPhotoJson, photoRpc } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { createUploadAttempt, describeAttemptResult } from '@/lib/photos/server/uploads';
import type { CancelUploadOutcome } from '@/lib/photos/upload-contract';

export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (body.owner_kind !== 'ordinary') throw new PhotoApiError('invalid_input');
    const args = { p_actor: actor.actorId, p_attempt_id: photoId(body.attempt_id) };
    let result: CancelUploadOutcome;
    try {
      result = await photoRpc(actor, 'photo_cancel_upload', args);
    } catch (error) {
      if (!(error instanceof PhotoApiError) || error.code !== 'not_found') throw error;
      // Identity is saved before create starts. Its response can be lost, or
      // cancellation can arrive first. Idempotently establish that exact owner
      // before cancelling; a delayed create cannot revive the cancelled row.
      await createUploadAttempt(actor, body);
      result = await photoRpc(actor, 'photo_cancel_upload', args);
    }
    if (result.status === 'cancelled') return photoJson(result);
    const bound = await photoRpc(actor, 'photo_lock_upload', {
      p_actor: actor.actorId, p_owner_kind: 'ordinary', p_owner_id: args.p_attempt_id,
    });
    return photoJson(await describeAttemptResult(actor, bound));
  });
}
