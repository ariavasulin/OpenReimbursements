import { isSha256 } from '@/lib/photos/apiShared';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';

/** Intentional global digest read: retained trash continues reserving its digest. */
export async function GET(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request);
    const digest = new URL(request.url).searchParams.get('sha256');
    if (!isSha256(digest)) throw new PhotoApiError('invalid_input');
    const { data, error } = await actor.db.from('photos')
      .select('id,job_id,deleted_at,purge_after')
      .eq('content_sha256', digest).limit(2);
    if (error) throwPhotoDatabaseError(error);
    // Until operator cutover establishes global uniqueness, never choose a canonical row.
    if (data && data.length > 1) throw new PhotoApiError('conflict');
    const photo = data?.[0];
    if (!photo) return photoJson({ status: 'not_found' });
    if (!photo.deleted_at) {
      return photoJson({ status: 'duplicate_active', photo_id: photo.id, job_id: photo.job_id });
    }
    const expiresAt = Date.parse(photo.purge_after);
    if (!Number.isFinite(expiresAt)) throw new PhotoApiError('temporarily_unavailable');
    const expired = expiresAt <= Date.now();
    return photoJson({
      status: 'duplicate_trashed', photo_id: photo.id, job_id: photo.job_id,
      purge_after: photo.purge_after, can_restore: !expired,
      remedy: expired ? 'This photo is awaiting permanent cleanup. Retry after cleanup completes.' :
        'Confirm restoration before uploading.',
    });
  });
}
