import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { ShopBridgeError, shopHealth } from '@/lib/shop/query';

export const dynamic = 'force-dynamic';

/**
 * Admin-only view of the office database link: is the bridge reachable through the
 * tunnel, and when did the mirror last copy each table. Never throws on a down bridge;
 * the mirror status still comes back from Postgres so the admin can see how stale it is.
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;

  const { supabaseAdmin } = await import('@/lib/supabaseAdminClient');
  const [bridge, mirror] = await Promise.all([
    shopHealth().catch((error: unknown) => {
      if (error instanceof ShopBridgeError) {
        return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
      }
      return { ok: false, error: { status: 500, code: 'unknown', message: 'Shop bridge check failed' } };
    }),
    supabaseAdmin.rpc('shop_sync_status').then(({ data, error }) => (error ? { error: error.message } : data)),
  ]);

  return NextResponse.json({ bridge, mirror }, { headers: { 'Cache-Control': 'no-store' } });
}
