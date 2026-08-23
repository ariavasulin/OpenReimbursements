import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { validate as isUuid } from 'uuid';
import { isSha256 } from '@/lib/photos/apiShared';

// GET /api/photos/exists?job=&sha= — dedupe pre-flight: does this job already
// have a photo with these exact bytes? Big files check BEFORE uploading so
// duplicate gigabytes never leave the phone; small files skip this and let
// the finalize unique index (photos_job_sha) answer instead.

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
  const sha = params.get('sha');
  if (!job || !isUuid(job)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }
  if (!isSha256(sha)) {
    return NextResponse.json({ error: 'Invalid sha' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('photos')
    .select('id')
    .eq('job_id', job)
    .eq('content_sha256', sha)
    .limit(1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ exists: (data ?? []).length > 0 });
}
