import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { validate as isUuid } from 'uuid';

// GET /api/photo-tags?job=&q= — distinct tags in use (optionally scoped to a
// job, optionally substring-filtered), for the Tags filter and upload
// type-ahead. Aggregated in SQL by the get_photo_tags RPC; this used to pull
// up to 10,000 rows and dedupe in JS.

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const job = params.get('job');
  const q = params.get('q')?.trim().toLowerCase() ?? '';

  if (job && !isUuid(job)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }

  // ilike '%q%' matches the old case-insensitive includes(); SQL `order by`
  // replaces localeCompare, which can order non-ASCII tags differently.
  const { data, error } = await supabase.rpc('get_photo_tags', {
    job_filter: job || null,
    q: q || null,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const tags = ((data ?? []) as { tag: string }[]).map((row) => row.tag);

  return NextResponse.json({ success: true, tags });
}
