import { photoJson, photoRoute } from '@/lib/photos/server/http';
import { readPhotoMe } from '@/lib/photos/server/me';

/**
 * GET /api/photos/me — the signed-in employee's photo permissions and settings
 * in one request: { actor: { user_id, photo_admin }, settings: { starter_tags,
 * slideshow: { shuffle, delay_seconds } } }. The same answers as GET
 * /api/photos/actor and GET /api/photos/settings, which a cold open asked for
 * separately. A read: it answers while photo writes are switched off.
 */
export async function GET() {
  return photoRoute(async () => photoJson(await readPhotoMe()));
}
