-- Indexes for the receipts hot paths.
--
-- CONCURRENTLY so this does not lock out writes.
--
-- Apply each statement individually via the positional form — see
-- supabase/migrations/README.md § Files that must be applied statement by
-- statement.

-- GET /api/receipts: where user_id = $1 order by receipt_date desc, created_at desc
-- Matches filter and sort, so the planner gets an ordered index scan with no sort node.
create index concurrently if not exists receipts_user_date_created
  on public.receipts (user_id, receipt_date desc, created_at desc);

-- POST /api/receipts/check-duplicate and the OCR dedupe probe:
-- where user_id = $1 and receipt_date = $2 and amount = $3
create index concurrently if not exists receipts_user_date_amount
  on public.receipts (user_id, receipt_date, amount);

-- get_admin_receipt_status_counts / get_admin_receipts_with_phone filter on a
-- date range and group by status.
create index concurrently if not exists receipts_date_status
  on public.receipts (receipt_date, status);
