import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';

export async function GET(request: Request) {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

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
