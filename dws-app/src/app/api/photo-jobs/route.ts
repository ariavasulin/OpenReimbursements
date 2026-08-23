import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { escapeIlikeWildcards } from '@/lib/photos/apiShared';
import {
  mapJobSummary,
  type PhotoJobSummaryRow,
} from '@/lib/photos/jobSummary';
import type { PhotoJobSummary } from '@/lib/photos/types';

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

  // Counts, latest-upload ordering, and the 4 newest thumbs per job are all
  // computed in SQL (get_photo_job_summaries).
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
