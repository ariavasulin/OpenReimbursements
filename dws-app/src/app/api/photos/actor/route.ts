import { photoJson, photoRoute } from '@/lib/photos/server/http';
import { readPhotoMe } from '@/lib/photos/server/me';

/**
 * GET /api/photos/actor — the signed-in employee's photo permissions:
 * { user_id, photo_admin }. The screens use it to offer Delete forever, Empty
 * trash, project Delete, and Trash only where they will work; every write still
 * checks the account and the rule in SQL. A deactivated account answers false,
 * as photo_actor_is_admin does. A read: it answers while photo writes are
 * switched off. GET /api/photos/me answers this and the settings together.
 */
export async function GET() {
  return photoRoute(async () => photoJson((await readPhotoMe()).actor));
}
