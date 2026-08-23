import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import type { Receipt } from '@/lib/types';

export async function GET(): Promise<NextResponse> {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

  try {
    const { data, error } = await supabase
      .from('receipts')
      .select(
        `
        id,
        receipt_date,
        amount,
        status,
        category_id,
        categories!receipts_category_id_fkey (name),
        description,
        image_url,
        user_profiles (
          full_name,
          employee_id_internal
        )
      `
      )
      .eq('status', 'Pending')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message || 'Failed to fetch pending receipts' }, { status: 500 });
    }

    const receipts: Receipt[] = (data ?? []).map((item: any) => ({
      id: item.id,
      employeeName: item.user_profiles?.full_name || 'N/A',
      employeeId: item.user_profiles?.employee_id_internal || 'N/A',
      date: item.receipt_date,
      amount: item.amount,
      category: item.categories?.name || 'Uncategorized',
      description: item.description || '',
      status: (item.status as string).toLowerCase() as Receipt['status'],
      image_url: item.image_url
        ? supabase.storage.from('receipt-images').getPublicUrl(item.image_url).data.publicUrl
        : '',
    }));

    return NextResponse.json({ success: true, receipts }, { status: 200 });
  } catch (error) {
    console.error('GET /api/receipts/pending: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}
