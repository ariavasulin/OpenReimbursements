import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { buildPayrollCsv, type PayrollReceiptRow } from '@/lib/payrollCsv';
import { normalizeReceiptSearch, receiptMatchesSearch } from '@/lib/receiptSearch';
import { employeeIdentity } from '@/lib/types';

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
    // Applied here with the same matcher the table uses, over the whole
    // filtered result set rather than the page on screen.
    const search = normalizeReceiptSearch(searchParams.get('q'));

    // PostgREST caps RPC responses at ~1000 rows. Strategy: ask for the total
    // count first, then fetch one Range per page, a few pages at a time. Each
    // page re-runs the full-result RPC, so the concurrency bound is what keeps
    // a large export from opening dozens of connections at once.
    const PAGE_SIZE = 1000;
    const PAGE_CONCURRENCY = 4;
    // Above this the export refuses rather than returning a short file: a
    // payroll CSV that silently stops at row 100,000 is worse than no CSV.
    const MAX_ROWS = 100_000;

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
    if (totalMatching > MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Export covers ${totalMatching} receipts; the limit is ${MAX_ROWS}. Narrow the date range or status and try again.`,
        },
        { status: 413 }
      );
    }
    const pageCount = Math.max(1, Math.ceil(totalMatching / PAGE_SIZE));

    const rows: PayrollReceiptRow[] = [];
    for (let start = 0; start < pageCount; start += PAGE_CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(PAGE_CONCURRENCY, pageCount - start) },
        (_, offset) => {
          const i = start + offset;
          return supabase
            .rpc('get_admin_receipts_with_phone', {
              status_filter: statusFilter || null,
              from_date: fromDate || null,
              to_date: toDate || null,
            })
            .range(i * PAGE_SIZE, (i + 1) * PAGE_SIZE - 1);
        }
      );
      const results = await Promise.all(batch);
      const failedPage = results.find((r) => r.error);
      if (failedPage?.error) {
        return NextResponse.json({ error: failedPage.error.message }, { status: 500 });
      }
      for (const r of results) {
        for (const item of (r.data ?? []) as any[]) {
          const row = {
            ...employeeIdentity(item),
            description: item.description ?? '',
            amount: item.amount,
          };
          if (receiptMatchesSearch(row, search)) rows.push(row);
        }
      }
    }

    const csv = buildPayrollCsv(rows);

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="receipts_totals_${new Date().toISOString().split('T')[0]}.csv"`,
        // Employee names and totals: never let a shared cache keep a copy.
        'Cache-Control': 'no-store',
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
