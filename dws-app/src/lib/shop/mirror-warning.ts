/**
 * The admin page's stale-sync warning: which mirrored tables have had no good copy for
 * over an hour (four missed runs at the default 15-minute interval), from
 * public.shop_sync_status(). No rows (the mirror has never run, e.g. no shop bridge)
 * means no warning.
 */
const MIRROR_STALE_MS = 60 * 60 * 1000;

export type ShopSyncStatusRow = { table: string; last_ok_at: string | null };
export type MirrorWarning = { tables: string[]; lastOkAt: string | null };

export function mirrorWarning(rows: ShopSyncStatusRow[], now: number): MirrorWarning | null {
  const stale = rows.filter(row => !row.last_ok_at || now - Date.parse(row.last_ok_at) > MIRROR_STALE_MS);
  if (stale.length === 0) return null;
  const times = stale.map(row => row.last_ok_at).filter((t): t is string => Boolean(t)).sort();
  // The oldest good copy among the stale tables; null when one of them never had one.
  const lastOkAt = times.length === stale.length ? times[0] : null;
  return { tables: stale.map(row => row.table), lastOkAt };
}
