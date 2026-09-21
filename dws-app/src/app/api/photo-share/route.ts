import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, PhotoApiError, readPhotoJson } from '@/lib/photos/server/http';
import { readShareStatus, setShare, shareTarget } from '@/lib/photos/server/sharing';

// The share switch for one album or one project. Signed-in employees only; any of them may share
// (photo-albums Decision 7). The public side is /api/share/[token], a different route on purpose.

/** `?album=<id>` or `?job=<id>` -> `{ enabled, url, created_at, pages_open }`. */
export async function GET(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request);
    const params = new URL(request.url).searchParams;
    return photoJson(await readShareStatus(actor, shareTarget(params.get('album'), params.get('job'))));
  });
}

/** `{ album_id | job_id, enabled }` -> `{ enabled, url, created_at }`. Turning a link on again makes a NEW link. */
export async function PUT(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (Object.keys(body).some(key => !['album_id', 'job_id', 'enabled'].includes(key))) throw new PhotoApiError('invalid_input');
    return photoJson(await setShare(actor, shareTarget(body.album_id, body.job_id), body.enabled));
  });
}
