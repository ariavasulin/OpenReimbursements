import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { escapeIlikeWildcards } from '@/lib/photos/apiShared';
import { mapJobSummary } from '@/lib/photos/jobSummary';
import type { PhotoJobSummary, PhotoJobSummaryRow } from '@/lib/photos/types';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';

// GET /api/photo-jobs?q= — job cards for the photos home screen and the
// upload job dropdown: job number, name, photo count, up to 4 newest thumbs.
// Ordered by most recent upload activity (jobs with photos first, newest
// upload first; then job number descending).

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';

  const escaped = escapeIlikeWildcards(q);
  const { data, error } = await supabase.rpc('get_photo_job_summaries', {
    search_query: escaped || null,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const jobs: PhotoJobSummary[] = ((data ?? []) as PhotoJobSummaryRow[]).map(
    mapJobSummary
  );

  return NextResponse.json({ success: true, jobs });
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
