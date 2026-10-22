-- The four admin functions below run with their owner's rights (security definer) and
-- carry no admin check of their own; the API routes that call them do the check, and
-- call them with the service role. The baseline (dumped from production) also granted
-- them to anon and authenticated, which means the public anon key could list users with
-- their phone numbers and read receipts through PostgREST. Found 2026-10-22 while
-- locking down the shop mirror role. This removes the grants no caller needs.
--
-- Callers today (dws-app/src/app/api/admin/...):
--   get_auth_users_for_admin, get_auth_users_count   -> supabaseAdmin (service role)
--   get_admin_receipt_status_counts                  -> service role after this change
--   get_admin_receipts_with_phone                    -> no caller
revoke execute on function public.get_auth_users_for_admin(integer, integer, text, boolean) from anon, authenticated, public;
revoke execute on function public.get_auth_users_count(text, boolean) from anon, authenticated, public;
revoke execute on function public.get_admin_receipts_with_phone(text, date, date) from anon, authenticated, public;
revoke execute on function public.get_admin_receipt_status_counts(date, date) from anon, authenticated, public;
grant execute on function public.get_auth_users_for_admin(integer, integer, text, boolean) to service_role;
grant execute on function public.get_auth_users_count(text, boolean) to service_role;
grant execute on function public.get_admin_receipts_with_phone(text, date, date) to service_role;
grant execute on function public.get_admin_receipt_status_counts(date, date) to service_role;
