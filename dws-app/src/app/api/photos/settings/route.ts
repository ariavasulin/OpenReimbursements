import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { readPhotoMe } from '@/lib/photos/server/me';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { cleanTags } from '@/lib/photos/apiShared';
import { SLIDESHOW_DELAY_CHOICES, type PhotoSettings } from '@/lib/photos/settings';

/**
 * GET /api/photos/settings — what the Settings page shows and the pickers read:
 * { starter_tags, slideshow: { shuffle, delay_seconds } }. starter_tags is the
 * app-wide default tag list (photo_settings); slideshow is the signed-in
 * person's own. A read: it answers while photo writes are switched off.
 * GET /api/photos/me answers this and the permissions together.
 */
export async function GET() {
  return photoRoute(async () => photoJson((await readPhotoMe()).settings));
}

/**
 * PATCH /api/photos/settings { starter_tags?: string[], slideshow?: { shuffle?, delay_seconds? } }
 * starter_tags: photo admins only (SQL refuses anyone else). slideshow: the
 * caller's own. Answers the whole settings object afterwards.
 */
export async function PATCH(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    onlyKeys(body, ['starter_tags', 'slideshow']);
    if (body.starter_tags === undefined && body.slideshow === undefined) throw new PhotoApiError('invalid_input');
    if (body.starter_tags !== undefined) {
      if (!Array.isArray(body.starter_tags) || body.starter_tags.length > 20 || body.starter_tags.some(tag => typeof tag !== 'string')) {
        throw new PhotoApiError('invalid_input');
      }
      await photoRpc(actor, 'photo_set_starter_tags', { p_actor: actor.actorId, p_tags: cleanTags(body.starter_tags) });
    }
    if (body.slideshow !== undefined) {
      const slideshow = body.slideshow;
      if (!slideshow || typeof slideshow !== 'object' || Array.isArray(slideshow)) throw new PhotoApiError('invalid_input');
      const { shuffle, delay_seconds: delay } = slideshow as Record<string, unknown>;
      onlyKeys(slideshow as Record<string, unknown>, ['shuffle', 'delay_seconds']);
      if ((shuffle !== undefined && typeof shuffle !== 'boolean') ||
          (delay !== undefined && !SLIDESHOW_DELAY_CHOICES.includes(delay as (typeof SLIDESHOW_DELAY_CHOICES)[number]))) {
        throw new PhotoApiError('invalid_input');
      }
      await photoRpc(actor, 'photo_set_slideshow', { p_actor: actor.actorId, p_shuffle: shuffle ?? null, p_delay_seconds: delay ?? null });
    }
    return photoJson(await readSettings(actor.session, actor.actorId));
  });
}

async function readSettings(session: Awaited<ReturnType<typeof createSupabaseServerClient>>, userId: string): Promise<PhotoSettings> {
  const [settings, profile] = await Promise.all([
    session.from('photo_settings').select('starter_tags').eq('singleton', true).maybeSingle(),
    session.from('user_profiles').select('slideshow_shuffle,slideshow_delay_seconds').eq('user_id', userId).maybeSingle(),
  ]);
  if (settings.error) throwPhotoDatabaseError(settings.error);
  if (profile.error) throwPhotoDatabaseError(profile.error);
  return {
    starter_tags: (settings.data?.starter_tags as string[] | undefined) ?? [],
    slideshow: {
      shuffle: profile.data?.slideshow_shuffle === true,
      delay_seconds: typeof profile.data?.slideshow_delay_seconds === 'number' ? profile.data.slideshow_delay_seconds : 4,
    },
  };
}
