import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { Receipt } from '@/lib/types';

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

  try {
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get('status');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

    // PostgREST caps RPC responses at ~1000 rows. We need the full result set
    // for the admin dashboard's client-side counts/filters/CSV. Strategy:
    // ask for the total count first, then fire one Range-based fetch per page
    // in parallel. Two round-trips total, regardless of dataset size.
    const PAGE_SIZE = 1000;
    const MAX_ROWS = 100_000; // hard guard if the counts RPC ever returns wild values

    const { data: countsData, error: countsError } = await supabase.rpc(
      'get_admin_receipt_status_counts',
      { from_date: fromDate || null, to_date: toDate || null }
    );
    if (countsError) {
      return NextResponse.json({ error: countsError.message }, { status: 500 });
    }
    const totalMatching = (countsData ?? []).reduce(
      (sum: number, row: { status: string; count: number | string }) => {
        if (statusFilter && statusFilter !== 'all' && row.status !== statusFilter) {
          return sum;
        }
        return sum + Number(row.count);
      },
      0
    );
    const expectedRows = Math.min(totalMatching, MAX_ROWS);
    const pageCount = Math.max(1, Math.ceil(expectedRows / PAGE_SIZE));

    const pageFetches = Array.from({ length: pageCount }, (_, i) =>
      supabase
        .rpc('get_admin_receipts_with_phone', {
          status_filter: statusFilter || null,
          from_date: fromDate || null,
          to_date: toDate || null,
        })
        .range(i * PAGE_SIZE, (i + 1) * PAGE_SIZE - 1)
    );
    const pageResults = await Promise.all(pageFetches);
    const failedPage = pageResults.find((r) => r.error);
    if (failedPage?.error) {
      return NextResponse.json({ error: failedPage.error.message }, { status: 500 });
    }
    const receiptsData: any[] = pageResults.flatMap((r) => r.data ?? []);

    const mappedReceipts = (receiptsData || []).map((item: any) => {
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
        employeeName: item.preferred_name || item.full_name || "Unknown",
        employeeId: item.employee_id_internal || "",
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
      receipts: mappedReceipts as Receipt[]
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/admin/receipts: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({
      error: `Error processing request: ${errorMessage}`
    }, { status: 500 });
  }
}
