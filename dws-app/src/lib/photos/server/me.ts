import 'server-only';
import type { PhotoPermissions } from '../permissions';
import { DEFAULT_SLIDESHOW, type PhotoSettings } from '../settings';
import { PhotoApiError, throwPhotoDatabaseError } from './http';
import { requirePhotoReader } from './reads';

export interface PhotoMe {
  actor: PhotoPermissions;
  settings: PhotoSettings;
}

/** One row of the get_photo_me RPC; null for no usable sign-in. */
interface PhotoMeRow {
  user_id: string;
  photo_admin: boolean;
  slideshow_shuffle: boolean;
  slideshow_delay_seconds: number | null;
  starter_tags: string[] | null;
}

/**
 * The signed-in person's photo permissions and settings, in ONE database call
 * through their own session (get_photo_me). Who they are comes from the token the
 * database verifies (auth.uid()), never from the cookie's unverified copy of
 * the user, so this needs no separate call to the Auth server. A read: it
 * answers while photo writes are switched off. Every write still checks the
 * account and its rights in SQL.
 */
export async function readPhotoMe(): Promise<PhotoMe> {
  const session = await requirePhotoReader();
  const { data, error } = await session.rpc('get_photo_me');
  if (error) throwPhotoDatabaseError(error);
  const row = data as PhotoMeRow | null;
  if (!row) throw new PhotoApiError('unauthenticated');
  return {
    actor: { user_id: row.user_id, photo_admin: row.photo_admin === true },
    settings: {
      starter_tags: row.starter_tags ?? [],
      slideshow: {
        shuffle: row.slideshow_shuffle === true,
        delay_seconds: typeof row.slideshow_delay_seconds === 'number' ? row.slideshow_delay_seconds : DEFAULT_SLIDESHOW.delay_seconds,
      },
    },
  };
}
