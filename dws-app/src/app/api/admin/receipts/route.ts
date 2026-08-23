import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { employeeIdentity, type Receipt } from '@/lib/types';

export async function GET(request: Request) {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

  try {
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get('status');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

    const page = Math.max(parseInt(searchParams.get('page') ?? '', 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(searchParams.get('pageSize') ?? '', 10) || 25, 1),
      200
    );

    // One bounded call. The full-result-set path lives on in ./export/route.ts,
    // where it runs only when someone exports the payroll CSV. The function
    // aggregates the filtered totals in a CTE and joins it to the page, so
    // every returned row repeats total_count/total_amount and no separate
    // counts round-trip is needed here.
    const { data, error } = await supabase.rpc('get_admin_receipts_page', {
      status_filter: statusFilter || null,
      from_date: fromDate || null,
      to_date: toDate || null,
      page_num: page,
      page_size: pageSize,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Every row carries the filtered totals. A page past the end of the result
    // set returns a single row with null receipt columns so the totals still
    // come back.
    const rows: any[] = data ?? [];
    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const totalAmount = rows.length > 0 ? Number(rows[0].total_amount) : 0;
    const receiptsData = rows.filter((row) => row.id !== null);

    const mappedReceipts = receiptsData.map((item: any) => {
      let publicImageUrl = item.image_url;

      if (item.image_url) {
        const { data: publicUrlData } = supabase.storage
          .from('receipt-images')
          .getPublicUrl(item.image_url);

        if (publicUrlData?.publicUrl) {
          publicImageUrl = publicUrlData.publicUrl;
        }
      }

      return {
        id: item.id,
        user_id: item.user_id,
        ...employeeIdentity(item),
        phone: item.phone || null,
        date: item.receipt_date,
        amount: item.amount,
        status: item.status,
        category_id: item.category_id,
        category: item.category_name || "Uncategorized",
        description: item.description || "",
        image_url: publicImageUrl,
        created_at: item.created_at,
        updated_at: item.updated_at,
      };
    });

    return NextResponse.json({
      success: true,
      receipts: mappedReceipts as Receipt[],
      totalCount,
      totalAmount,
      page,
      pageSize,
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/admin/receipts: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({
      error: `Error processing request: ${errorMessage}`
    }, { status: 500 });
  }
}
