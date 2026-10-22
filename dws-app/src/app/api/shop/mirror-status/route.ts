import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { mirrorWarning, type ShopSyncStatusRow } from '@/lib/shop/mirror-warning';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';

export const dynamic = 'force-dynamic';

/**
 * Admin-only: whether the shop mirror has gone more than an hour without a good copy
 * of some table, for the warning on the admin receipts page. Reads only Postgres, so
 * it is cheap to call on every page load. A missing status function (the shop
 * migrations not applied yet) reads as no warning.
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;

  const { data, error } = await supabaseAdmin.rpc('shop_sync_status');
  const warning = error ? null : mirrorWarning(data as ShopSyncStatusRow[], Date.now());
  return NextResponse.json({ warning }, { headers: { 'Cache-Control': 'no-store' } });
}
