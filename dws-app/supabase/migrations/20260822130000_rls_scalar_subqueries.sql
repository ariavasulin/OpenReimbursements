-- Wrap auth.uid() and is_admin() in scalar subqueries so Postgres evaluates
-- them once per statement (as an InitPlan) instead of once per row.
-- Predicate semantics are unchanged; only evaluation frequency changes.
begin;

drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts
  for select
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists receipts_insert on public.receipts;
create policy receipts_insert on public.receipts
  for insert
  with check (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists receipts_update on public.receipts;
create policy receipts_update on public.receipts
  for update
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists receipts_delete on public.receipts;
create policy receipts_delete on public.receipts
  for delete
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists categories_delete on public.categories;
create policy categories_delete on public.categories
  for delete to authenticated using ((select public.is_admin()));

-- The five user_profiles policies (created in the dashboard, captured in the
-- Phase 1 baseline at 00000000000000_baseline.sql:417-500) get the same
-- treatment. Names, commands, roles (no TO clause = public), and predicate
-- semantics are unchanged; "user_profiles_update_policy" keeps no explicit
-- WITH CHECK, matching the live NULL with_check in pg_policies.

drop policy if exists "Users can update their own profile" on public.user_profiles;
create policy "Users can update their own profile" on public.user_profiles
  for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can view their own profile" on public.user_profiles;
create policy "Users can view their own profile" on public.user_profiles
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists user_profiles_insert_policy on public.user_profiles;
create policy user_profiles_insert_policy on public.user_profiles
  for insert
  with check ((select auth.uid()) is not null);

drop policy if exists user_profiles_select_policy on public.user_profiles;
create policy user_profiles_select_policy on public.user_profiles
  for select
  using ((select auth.uid()) is not null);

drop policy if exists user_profiles_update_policy on public.user_profiles;
create policy user_profiles_update_policy on public.user_profiles
  for update
  using ((select auth.uid()) = user_id);

commit;
