import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { validate as isUuid } from 'uuid';

// GET /api/photo-tags?job=&q= — distinct tags in use (optionally scoped to a
// job, optionally prefix-filtered), for the Tags filter and upload type-ahead.
// TODO: aggregate in SQL (view/RPC)

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
    if (!isUuid(job)) {
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
    for (const tag of row.tags) {
      if (!q || tag.toLowerCase().includes(q)) distinct.add(tag);
    }
  }
  const tags = [...distinct].sort((a, b) => a.localeCompare(b));

  return NextResponse.json({ success: true, tags });
}
