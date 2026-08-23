import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { buildPayrollCsv, type PayrollReceiptRow } from '@/lib/payrollCsv';
import { employeeIdentity } from '@/lib/types';

// PostgREST caps a response at ~1000 rows, so the export pages the RPC; the
// concurrency bound keeps a large export from opening dozens of connections
// at once.
const PAGE_SIZE = 1000;
const PAGE_CONCURRENCY = 4;
// Above this the export refuses rather than returning a short file: a
// payroll CSV that silently stops at row 100,000 is worse than no CSV.
const MAX_ROWS = 100_000;

export async function GET(request: Request) {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

  try {
    const { searchParams } = new URL(request.url);
    const filterArgs = {
      status_filter: searchParams.get('status') || null,
      from_date: searchParams.get('fromDate') || null,
      to_date: searchParams.get('toDate') || null,
      search_term: searchParams.get('q') || null,
    };
    const fetchPage = (pageNum: number) =>
      supabase
        .rpc('get_admin_receipts_page', { ...filterArgs, page_num: pageNum, page_size: PAGE_SIZE })
        .select('id,total_count,preferred_name,full_name,employee_id_internal,amount');

    const rows: PayrollReceiptRow[] = [];
    const collect = (data: any[] | null) => {
      for (const item of data ?? []) {
        if (item.id === null) continue;
        rows.push({ ...employeeIdentity(item), amount: item.amount });
      }
    };

    const first = await fetchPage(1);
    if (first.error) {
      return NextResponse.json({ error: first.error.message }, { status: 500 });
    }
    // Every row carries the filtered totals; an empty set returns one
    // null-id row that still does.
    const totalMatching = first.data?.length ? Number(first.data[0].total_count) : 0;
    if (totalMatching > MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Export covers ${totalMatching} receipts; the limit is ${MAX_ROWS}. Narrow the date range or status and try again.`,
        },
        { status: 413 }
      );
    }
    collect(first.data);

    const pageCount = Math.ceil(totalMatching / PAGE_SIZE);
    for (let start = 2; start <= pageCount; start += PAGE_CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(PAGE_CONCURRENCY, pageCount - start + 1) },
        (_, offset) => fetchPage(start + offset)
      );
      const results = await Promise.all(batch);
      const failedPage = results.find((r) => r.error);
      if (failedPage?.error) {
        return NextResponse.json({ error: failedPage.error.message }, { status: 500 });
      }
      for (const r of results) collect(r.data);
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
