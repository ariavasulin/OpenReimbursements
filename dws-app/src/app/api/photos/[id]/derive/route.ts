import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { WorkBudget } from '@/lib/photos/repair/deadline';
import { mediaExecutor } from '@/lib/photos/repair/executor';
import { fillImageDerivatives } from '@/lib/photos/repair/transforms';
import type { RepairRow } from '@/lib/photos/repair/sweep';

interface RouteContext { params: Promise<{ id: string }> }

/** Vercel's function limit for the request; the work budget below stays inside it. */
export const maxDuration = 300;
const WORK_MS = 280_000;

const ROW = 'id,uploader_id,kind,mime_type,original_path,original_bytes,thumb_path,preview_path,duration_secs,'
  + 'playback_path,playback_skipped_reason,poster_skipped_reason,created_at,upload_warnings';
type Row = RepairRow & { preview_path: string | null; duration_secs: number | null; upload_warnings: unknown };

/** The upload client's own note when it left the previews to the server. */
const isPreviewWarning = (warning: unknown) => typeof warning === 'string' && warning.startsWith('Previews ');

/**
 * POST /api/photos/<id>/derive — make the thumbnail and preview the uploader's
 * browser could not: a HEIC picked on a desktop, a TIFF, an image over the
 * browser's 24 MB decoding budget, a video the browser cannot play. The same
 * renderers as the nightly repair sweep (sharp, the transform endpoint for
 * HEIC, ffmpeg for a video poster), run at once for this one photo so it has a
 * preview when the upload finishes rather than the next morning. Any signed-in
 * employee may ask: the derived keys are fixed per photo and only an empty
 * slot is filled. A photo the renderers refuse answers `thumb_path: null`
 * with the reason and stays as it is; the sweep decides later whether it is a
 * file tile.
 */
export async function POST(request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const startedAt = Date.now();
    const actor = await requirePhotoActor(request, { mutation: true });
    const id = photoId((await context.params).id);
    const read = await actor.db.from('photos').select(ROW).eq('id', id).is('deleted_at', null).maybeSingle();
    if (read.error) throwPhotoDatabaseError(read.error);
    const row = read.data as Row | null;
    if (!row) throw new PhotoApiError('not_found');
    const answer = (current: Row, reason?: string) => photoJson({
      success: true, photo_id: id, thumb_path: current.thumb_path, preview_path: current.preview_path,
      duration_secs: current.duration_secs, ...(reason ? { reason } : {}),
    });
    if (row.thumb_path) return answer(row);
    if (row.kind !== 'image' && row.kind !== 'video') return answer(row, 'not a photo or video');

    const budget = new WorkBudget(startedAt, WORK_MS);
    let reason: string | undefined;
    if (row.kind === 'image') {
      const result = await fillImageDerivatives(actor.db, row, budget);
      if (!result.ok) reason = result.reason;
    } else {
      let made = false;
      await mediaExecutor(actor.db, budget)([{ action: 'makeVideoPoster', photoId: id }], row, key => {
        if (key === 'makeVideoPoster') made = true;
      });
      if (!made) reason = 'poster skipped';
    }
    if (reason) return answer(row, reason);

    const after = await actor.db.from('photos').select(ROW).eq('id', id).is('deleted_at', null).maybeSingle();
    if (after.error) throwPhotoDatabaseError(after.error);
    const filled = after.data as Row | null;
    if (!filled) throw new PhotoApiError('not_found');
    // The upload's "Previews skipped…" note is no longer true.
    if (Array.isArray(filled.upload_warnings) && filled.upload_warnings.some(isPreviewWarning)) {
      const kept = filled.upload_warnings.filter(warning => !isPreviewWarning(warning));
      const cleared = await actor.db.from('photos').update({ upload_warnings: kept }).eq('id', id).is('deleted_at', null);
      if (cleared.error) throwPhotoDatabaseError(cleared.error);
    }
    return answer(filled);
  });
}
