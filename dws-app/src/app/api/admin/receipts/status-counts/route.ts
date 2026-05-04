import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const fromDate = searchParams.get('fromDate');
  const toDate = searchParams.get('toDate');

  const { data, error } = await supabase.rpc('get_admin_receipt_status_counts', {
    from_date: fromDate || null,
    to_date: toDate || null,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = { pending: 0, approved: 0, rejected: 0, reimbursed: 0, total: 0 };
  for (const row of data ?? []) {
    const key = row.status?.toLowerCase() as keyof typeof counts;
    if (key in counts) counts[key] = Number(row.count);
    counts.total += Number(row.count);
  }

  return NextResponse.json({ success: true, counts });
}
