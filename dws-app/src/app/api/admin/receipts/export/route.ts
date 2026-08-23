import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { buildPayrollCsv } from '@/lib/payrollCsv';
import { normalizeReceiptSearch, receiptMatchesSearch } from '@/lib/receiptSearch';

// The admin dashboard's payroll export needs every matching row: a bulk read,
// run only when someone clicks Export, paged around PostgREST's ~1000-row cap.
export async function GET(request: Request) {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

  try {
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get('status');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    // The dashboard's search box is part of what the admin sees when they hit
    // Export. Without it the CSV covered every employee no matter what was
    // typed. Applied here with the same matcher the table uses, over the whole
    // filtered result set rather than the page on screen.
    const search = normalizeReceiptSearch(searchParams.get('q'));

    // PostgREST caps RPC responses at ~1000 rows. Strategy: ask for the total
    // count first, then fire one Range-based fetch per page in parallel. Two
    // round-trips total, regardless of dataset size.
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

    // Same employeeName/employeeId derivation the dashboard applied to these
    // rows before the CSV logic moved server-side.
    const rows = receiptsData.map((item: any) => ({
      employeeId: item.employee_id_internal || '',
      employeeName: item.preferred_name || item.full_name || 'Unknown',
      description: item.description ?? '',
      amount: item.amount,
    }));

    const csv = buildPayrollCsv(
      rows.filter((row) => receiptMatchesSearch(row, search))
    );

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="receipts_totals_${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error) {
    console.error('GET /api/admin/receipts/export: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({
      error: `Error processing request: ${errorMessage}`
    }, { status: 500 });
  }
}
