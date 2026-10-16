import { PhotoApiError, photoJson, photoRoute, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { BULK_BODY_BYTES, bulkPhotoIds, requirePhotoReader } from '@/lib/photos/server/reads';

// POST /api/photos/rows {photo_ids}
//      What a zip download needs to know about up to 500 photos, by id: path,
//      size, names, capture time. { photos }, only those still available
//      (trashed or unknown ids are simply absent), in no particular order.
//      For selected photos the grid has not loaded ("Select all" past the
//      loaded pages), so sizing a download no longer walks the whole list.
//      Read through the employee's session, like GET /api/photos.

/** The fields a zip needs (ZipRow in lib/photos/zip-download.ts). */
const ZIP_COLUMNS = 'id,original_path,original_bytes,original_name,display_name,captured_at';

/** Ids per read: a long `in` list makes a long URL. */
const READ_STEP = 100;

export async function POST(request: Request) {
  return photoRoute(async () => {
    const session = await requirePhotoReader();
    const body = await readPhotoJson(request, BULK_BODY_BYTES);
    if (Object.keys(body).some(key => key !== 'photo_ids')) throw new PhotoApiError('invalid_input');
    const ids = [...new Set(bulkPhotoIds(body.photo_ids))];
    const reads: string[][] = [];
    for (let start = 0; start < ids.length; start += READ_STEP) reads.push(ids.slice(start, start + READ_STEP));
    const answers = await Promise.all(
      reads.map(chunk => session.from('photos').select(ZIP_COLUMNS).in('id', chunk).is('deleted_at', null)),
    );
    const photos = answers.flatMap(({ data, error }) => {
      if (error) throwPhotoDatabaseError(error);
      return data ?? [];
    });
    return photoJson({ photos });
  });
}
