import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { PhotoPermissions } from '@/lib/photos/permissions';
import { PhotoApiError, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';

/**
 * GET /api/photos/actor — the signed-in employee's photo permissions:
 * { user_id, photo_admin }. The screens use it to offer Delete forever, Empty
 * trash, project Delete, and Trash only where they will work; every write still
 * checks the account and the rule in SQL. Read on each request, so a change on
 * the Users page is live at once. A read: it answers while photo writes are
 * switched off.
 */
export async function GET() {
  return photoRoute(async () => {
    const session = await createSupabaseServerClient();
    const { data, error } = await session.auth.getUser();
    if (error || !data.user || data.user.is_anonymous) throw new PhotoApiError('unauthenticated');
    const profile = await session.from('user_profiles').select('photo_admin')
      .eq('user_id', data.user.id).maybeSingle();
    if (profile.error) throwPhotoDatabaseError(profile.error);
    const actor: PhotoPermissions = { user_id: data.user.id, photo_admin: profile.data?.photo_admin === true };
    return photoJson(actor);
  });
}
