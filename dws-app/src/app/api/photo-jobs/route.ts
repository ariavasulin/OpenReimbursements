import { collectionNextCursor, readCollectionPage } from '@/lib/photos/server/collectionPagination';
import { requirePhotoReader } from '@/lib/photos/server/reads';
import type { CollectionPage } from '@/lib/photos/collectionPagination';
import { escapeIlikeWildcards } from '@/lib/photos/apiShared';
import { mapJobSummary } from '@/lib/photos/jobSummary';
import type { PhotoJobSummaryRow } from '@/lib/photos/types';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';

// GET /api/photo-jobs?q= — job cards for the photos home screen and the
// upload job dropdown: job number, name, photo count, up to 4 newest thumbs.
// Ordered by most recent upload activity (jobs with photos first, newest
// upload first; then job number descending).

export async function GET(request: Request) {
  return photoRoute(async () => {
    const supabase = await requirePhotoReader();
    const { q, limit, cursor } = readCollectionPage(new URL(request.url).searchParams, 'jobs');
    const { data, error } = await supabase.rpc('get_photo_job_summaries_page', {
      search_query: escapeIlikeWildcards(q) || null, p_limit: limit,
      p_after_activity: cursor?.activity ?? null, p_after_number: cursor?.number ?? null,
      p_after_id: cursor?.id ?? null,
    });
    if (error) throwPhotoDatabaseError(error);
    const page = data as CollectionPage<PhotoJobSummaryRow>;
    return photoJson({ success: true, jobs: page.rows.map(mapJobSummary),
      nextCursor: collectionNextCursor('jobs', q, page.next_cursor) });
  });
}

const optionalText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PhotoApiError('invalid_input');
  return value;
};

// POST /api/photo-jobs { name, job_number?, location? } — create a project by
// hand. A blank job number receives a generated P-<n> code; an existing job
// number returns that job with status 'exists' instead of creating another.
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (typeof body.name !== 'string') throw new PhotoApiError('invalid_input');
    const result = await photoRpc(actor, 'photo_create_job', {
      p_actor: actor.actorId, p_name: body.name,
      p_job_number: optionalText(body.job_number), p_location: optionalText(body.location),
    });
    return photoJson(result, result.status === 'created' ? 201 : 200);
  });
}
