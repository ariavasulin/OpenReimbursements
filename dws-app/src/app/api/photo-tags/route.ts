import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';

// GET /api/photo-tags?job=&q= — distinct tags in use (optionally scoped to a
// job, optionally prefix-filtered), for the Tags filter and upload type-ahead.
// Distinct-unnest is done in the route; trivially fast at DWS scale.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  let query = supabase.from('photos').select('tags').limit(10000);
  if (job) {
    if (!UUID_RE.test(job)) {
      return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
    }
    query = query.eq('job_id', job);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const distinct = new Set<string>();
  for (const row of data ?? []) {
    for (const tag of row.tags ?? []) {
      if (typeof tag === 'string' && tag) distinct.add(tag);
    }
  }

  let tags = [...distinct].sort((a, b) => a.localeCompare(b));
  if (q) {
    tags = tags.filter((tag) => tag.toLowerCase().includes(q));
  }

  return NextResponse.json({ success: true, tags });
}
