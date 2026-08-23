-- Two baseline indexes became strict prefixes of indexes added in
-- 20260822120000 and were left behind:
--
--   idx_receipts_user_id      (user_id)       ⊂ receipts_user_date_created
--   idx_receipts_receipt_date (receipt_date)  ⊂ receipts_date_status
--
-- A composite index serves every lookup its prefix did, so the prefixes are
-- write amplification on the busiest write table and nothing else.
--
-- Apply each statement on its own via the positional form — see
-- supabase/migrations/README.md § Files that must be applied statement by
-- statement.

drop index concurrently if exists public.idx_receipts_user_id;

drop index concurrently if exists public.idx_receipts_receipt_date;
