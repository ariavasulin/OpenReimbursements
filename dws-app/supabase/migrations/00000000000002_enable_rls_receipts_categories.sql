-- Baseline capture of the RLS posture on public.receipts and public.categories,
-- carried forward from the pre-migrations db/ directory. Kept as the record of
-- the original schema, not as something to re-run by hand; it exists so a fresh
-- database can be rebuilt from the repo alone.
--
-- What it does:
--   1. Defines public.is_admin() — a SECURITY DEFINER helper that encodes the
--      same admin semantics copy-pasted throughout the app
--      (user_profiles.role = 'admin' for the calling auth.uid()).
--   2. Enables RLS on public.receipts with owner-or-admin policies for
--      select / insert / update / delete.
--   3. Enables RLS on public.categories: read for any authenticated user,
--      writes restricted to admins.
--
-- These policies are intentionally compatible with all existing access paths:
--   - the server-anon /api/receipts routes already filter by user_id / role,
--     so they satisfy `user_id = auth.uid() OR is_admin()`;
--   - admin browser-direct paths run under an admin session that is_admin()
--     satisfies;
--   - the SECURITY DEFINER RPCs (get_admin_receipts_with_phone, etc.) run with
--     definer privileges and are unaffected by RLS.

begin;

-- ---------------------------------------------------------------------------
-- is_admin(): does the calling user have the 'admin' role?
--
-- SECURITY DEFINER so the lookup against user_profiles is not itself subject to
-- the caller's RLS on user_profiles. STABLE because it performs no writes and
-- returns the same result within a statement. Locks search_path to a safe value
-- to avoid search_path-hijacking under SECURITY DEFINER.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_profiles up
    where up.user_id = auth.uid()
      and up.role = 'admin'
  );
$$;

-- Only the API roles need to evaluate this predicate.
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- receipts: RLS on; owner-or-admin for every operation.
-- ---------------------------------------------------------------------------
alter table public.receipts enable row level security;

drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts
  for select
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists receipts_insert on public.receipts;
create policy receipts_insert on public.receipts
  for insert
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists receipts_update on public.receipts;
create policy receipts_update on public.receipts
  for update
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists receipts_delete on public.receipts;
create policy receipts_delete on public.receipts
  for delete
  using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- categories: RLS on; authenticated read, admin-only write.
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select
  to authenticated
  using (true);

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists categories_delete on public.categories;
create policy categories_delete on public.categories
  for delete
  to authenticated
  using (public.is_admin());

commit;

-- ---------------------------------------------------------------------------
-- Verification (run after committing):
--   select rowsecurity from pg_tables
--   where schemaname = 'public' and tablename in ('receipts', 'categories');
--   -- expect: true for both
--
--   select * from pg_policies where schemaname = 'public'
--   and tablename in ('receipts', 'categories');
--   -- expect: the receipts_* and categories_* policies above
-- ---------------------------------------------------------------------------
