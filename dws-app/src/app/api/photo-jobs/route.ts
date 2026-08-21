import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { escapeForIlike } from '@/lib/photos/apiShared';
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

  let jobsQuery = supabase
    .from('jobs')
    .select('id, job_number, name, location')
    .eq('is_active', true);

  if (q) {
    const escaped = escapeForIlike(q);
    if (escaped) {
      jobsQuery = jobsQuery.or(
        `job_number.ilike.%${escaped}%,name.ilike.%${escaped}%`
      );
    }
  }

  const { data: jobs, error: jobsError } = await jobsQuery;
  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  // Newest-first photo rows; aggregated per job below (count, latest upload,
  // first 4 thumbnails). TODO: aggregate in SQL (view/RPC)
  const { data: photoRows, error: photosError } = await supabase
    .from('photos')
    .select('job_id, thumb_path, created_at')
    .order('created_at', { ascending: false })
    .limit(10000);
  if (photosError) {
    return NextResponse.json({ error: photosError.message }, { status: 500 });
  }

  const byJob = new Map<
    string,
    { count: number; latest: string | null; thumbs: string[] }
  >();
  for (const row of photoRows ?? []) {
    let agg = byJob.get(row.job_id);
    if (!agg) {
      agg = { count: 0, latest: null, thumbs: [] };
      byJob.set(row.job_id, agg);
    }
    agg.count += 1;
    if (!agg.latest) agg.latest = row.created_at; // rows arrive newest-first
    if (agg.thumbs.length < 4 && row.thumb_path) {
      agg.thumbs.push(row.thumb_path);
    }
  }

  const summaries: PhotoJobSummary[] = (jobs ?? []).map((job) => {
    const agg = byJob.get(job.id);
    return {
      id: job.id,
      job_number: job.job_number,
      name: job.name,
      location: job.location,
      photo_count: agg?.count ?? 0,
      latest_upload_at: agg?.latest ?? null,
      thumb_paths: agg?.thumbs ?? [],
    };
  });

  summaries.sort((a, b) => {
    if (a.latest_upload_at && b.latest_upload_at) {
      return a.latest_upload_at < b.latest_upload_at ? 1 : -1;
    }
    if (a.latest_upload_at) return -1;
    if (b.latest_upload_at) return 1;
    return b.job_number.localeCompare(a.job_number, undefined, {
      numeric: true,
    });
  });

  return NextResponse.json({ success: true, jobs: summaries });
}
