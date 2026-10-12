import { validate as isUuid } from 'uuid';
import { escapeIlikeWildcards, isSha256 } from '@/lib/photos/apiShared';
import { baseName } from '@/lib/photos/classify';
import { isIsoTimestamp } from '@/lib/keysetCursor';
import { requirePhotoReader } from '@/lib/photos/server/reads';
import { PhotoApiError, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { FORMAT_TWIN_WINDOW_MS, type FormatTwin } from '@/lib/photos/upload-contract';

/**
 * GET /api/photos/twin?job=&base=&captured_at=&sha= — the same shot in another format.
 * An active image in project `job` whose original name is `base` plus one extension (any case),
 * captured within a second of `captured_at`, with different bytes than `sha` (when given; a
 * matching hash is the existing duplicate rule's case, not this one). Answers `{photo}` or
 * `{photo: null}`. The uploader asks before claiming an image, so a second-format copy
 * (IMG_1234.CR2 beside IMG_1234.JPG) is held for a decision instead of uploaded unasked. Videos
 * are never twins: an iPhone Live Photo's IMG_1234.MOV is its own thing beside IMG_1234.HEIC.
 */
export async function GET(request: Request) {
  return photoRoute(async () => {
    const session = await requirePhotoReader();
    const params = new URL(request.url).searchParams;
    const job = params.get('job');
    const base = params.get('base') ?? '';
    const capturedAt = params.get('captured_at') ?? '';
    const sha = params.get('sha');
    if (!job || !isUuid(job) || !base || base.length > 255 || !isIsoTimestamp(capturedAt) ||
        (sha !== null && !isSha256(sha))) {
      throw new PhotoApiError('invalid_input');
    }
    const at = Date.parse(capturedAt);
    // Row rules hide trashed photos. The name pattern narrows in SQL; the exact base-name test
    // below drops a longer name that shares the prefix ("IMG_1234.edit.jpg").
    const { data, error } = await session.from('photos')
      .select('id,job_id,original_name,display_name,captured_at,content_sha256')
      .eq('job_id', job)
      .eq('kind', 'image')
      .ilike('original_name', `${escapeIlikeWildcards(base)}.%`)
      .gte('captured_at', new Date(at - FORMAT_TWIN_WINDOW_MS).toISOString())
      .lte('captured_at', new Date(at + FORMAT_TWIN_WINDOW_MS).toISOString())
      .order('captured_at', { ascending: true })
      .limit(20);
    if (error) throwPhotoDatabaseError(error);
    const wanted = base.toLowerCase();
    const hit = (data ?? []).find((row) => row.original_name &&
      baseName(row.original_name).toLowerCase() === wanted && row.content_sha256 !== sha);
    const photo: FormatTwin | null = hit ? {
      id: hit.id, job_id: hit.job_id, original_name: hit.original_name,
      display_name: hit.display_name, captured_at: hit.captured_at,
    } : null;
    return photoJson({ photo });
  });
}
