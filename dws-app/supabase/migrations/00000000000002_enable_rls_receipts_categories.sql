-- Baseline capture of the RLS posture on public.receipts and public.categories,
-- carried forward from the pre-migrations db/ directory. Kept as the record of
-- the original schema, not as something to re-run by hand; it exists so a fresh
-- database can be rebuilt from the repo alone.

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
-- receipts: RLS on.
-- ---------------------------------------------------------------------------
alter table public.receipts enable row level security;

-- The four receipts_* policies are defined in
-- 20260822130000_rls_scalar_subqueries.sql.

-- ---------------------------------------------------------------------------
-- categories: RLS on; authenticated read.
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select
  to authenticated
  using (true);

-- categories_insert/update/delete are defined in
-- 20260822130000_rls_scalar_subqueries.sql.

commit;
