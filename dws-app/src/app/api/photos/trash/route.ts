import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';

/** Intentional trash read: only unexpired recovery rows, at most 100 per page. */
export async function GET(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get('limit') ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PhotoApiError('invalid_input');
    let query = actor.db.from('photos')
      .select('id,job_id,uploader_id,kind,original_name,thumb_path,deleted_at,purge_after,duplicate_of')
      .not('deleted_at', 'is', null).gt('purge_after', new Date().toISOString())
      .order('id', { ascending: true }).limit(limit + 1);
    if (params.has('after')) query = query.gt('id', photoId(params.get('after')));
    if (params.has('job_id')) query = query.eq('job_id', photoId(params.get('job_id')));
    const { data, error } = await query;
    if (error) throwPhotoDatabaseError(error);
    const rows = data ?? [];
    const photos = rows.slice(0, limit);
    return photoJson({ photos, next_cursor: rows.length > limit ? photos.at(-1)!.id : null });
  });
}
