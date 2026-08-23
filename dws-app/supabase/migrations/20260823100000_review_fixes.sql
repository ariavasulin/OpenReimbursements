-- Review fixes: authorization, privilege, and convergence items.
--
-- Every statement is idempotent and transactional: the file applies as one
-- `db query -f` run.


-- 1. get_admin_receipts_page: authorization gate and empty-page totals.
--    The API route's admin check does not protect a `security definer`
--    function reachable over PostgREST, so the function checks is_admin()
--    itself. `totals left join page` always yields at least one row; callers
--    must skip rows with a null id (the API route does).
create or replace function public.get_admin_receipts_page(
    status_filter text default null,
    from_date date default null,
    to_date date default null,
    page_num int default 1,
    page_size int default 25
) returns table(
    id uuid,
    receipt_date date,
    amount numeric,
    status text,
    description text,
    image_url text,
    category_id uuid,
    user_id uuid,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    category_name text,
    full_name text,
    preferred_name text,
    employee_id_internal text,
    phone text,
    total_count bigint,
    total_amount numeric
)
language plpgsql
stable
security definer
set search_path to 'public', 'auth'
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  -- The filter is applied once, in `filtered`. `totals` and `page` both read
  -- from it, so the totals cannot drift out of step with the paged rows.
  with filtered as (
    select
      r.id,
      r.receipt_date,
      r.amount,
      r.status,
      r.description,
      r.image_url,
      r.category_id,
      r.user_id,
      r.created_at,
      r.updated_at
    from public.receipts r
    where
      (status_filter is null or status_filter = 'all' or r.status = status_filter)
      and (from_date is null or r.receipt_date >= from_date)
      and (to_date is null or r.receipt_date < to_date)
  ),
  totals as (
    select count(*) as total_count, coalesce(sum(f.amount), 0) as total_amount
    from filtered f
  ),
  page as (
    select
      f.id,
      f.receipt_date,
      f.amount,
      f.status,
      f.description,
      f.image_url,
      f.category_id,
      f.user_id,
      f.created_at,
      f.updated_at,
      c.name as category_name,
      up.full_name,
      up.preferred_name,
      up.employee_id_internal,
      au.phone
    from filtered f
    left join public.user_profiles up on f.user_id = up.user_id
    left join auth.users au on f.user_id = au.id
    left join public.categories c on f.category_id = c.id
    order by f.receipt_date desc, f.created_at desc
    limit greatest(page_size, 1)
    offset greatest(page_num - 1, 0) * greatest(page_size, 1)
  )
  select
    page.id,
    page.receipt_date,
    page.amount,
    page.status,
    page.description,
    page.image_url,
    page.category_id,
    page.user_id,
    page.created_at,
    page.updated_at,
    page.category_name,
    page.full_name,
    page.preferred_name,
    page.employee_id_internal,
    page.phone,
    totals.total_count,
    totals.total_amount
  from totals
  left join page on true
  order by page.receipt_date desc nulls last, page.created_at desc nulls last;
end;
$$;

comment on function public.get_admin_receipts_page(text, date, date, int, int) is
  'Paginated admin receipts listing with user profile data and phone numbers. Same body as get_admin_receipts_with_phone plus a bounded page and total_count/total_amount aggregated over public.receipts alone. Security definer for auth-schema access; raises "not authorized" unless public.is_admin(). An out-of-range page returns a single row whose receipt columns are null and which carries the totals — callers must skip rows with a null id.';

revoke all on function public.get_admin_receipts_page(text, date, date, int, int) from public, anon;
grant execute on function public.get_admin_receipts_page(text, date, date, int, int) to authenticated, service_role;


-- 2. user_profiles: close the privilege-escalation path.
--
--    `authenticated` held table-wide UPDATE, and user_profiles_update_policy is
--    only `auth.uid() = user_id`, so any employee could PATCH their own row to
--    {"role":"admin"} over PostgREST and is_admin() would start returning true.
--    Column-level grants express the actual rule. The only user-scoped write in
--    the app is PATCH /api/profile, which sets full_name on the caller's own
--    row; every other profile write (role, preferred_name,
--    employee_id_internal, deleted_at) goes through an admin route using the
--    service-role key, which is unaffected by these grants.
revoke update on public.user_profiles from authenticated;
grant update (full_name) on public.user_profiles to authenticated;

-- Same grant on `anon` is dead weight (RLS blocks it, auth.uid() is null) but
-- it is one policy edit away from mattering.
revoke update on public.user_profiles from anon;


-- 3. photos: `anon` held table-wide UPDATE (all 21 columns). RLS blocks it
--    today; revoke it so the grant is not what stands between a policy change
--    and a rewrite of uploader_id/original_path on any row.
revoke update on public.photos from anon;


-- 4. Re-apply 20260822130100 (photos-table write policies) and 20260822130200
--    (photos-bucket storage policies); bodies are copied verbatim from those
--    files.

drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos
  for insert to authenticated
  with check (uploader_id = (select auth.uid()));

drop policy if exists photos_update on public.photos;
create policy photos_update on public.photos
  for update to authenticated using (true) with check (true);

revoke update on public.photos from authenticated;
grant update (job_id, sheet_number, tags) on public.photos to authenticated;

drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos
  for delete to authenticated
  using (uploader_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists photos_storage_insert on storage.objects;
create policy photos_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists photos_storage_select on storage.objects;
create policy photos_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists photos_storage_update on storage.objects;
create policy photos_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );


-- 5. Rebuild-from-repo gaps (see README § What the baseline does not contain).
--    The trigger is created only when absent: `create or replace trigger` on
--    auth.users needs ownership of that table.
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth'
      and c.relname = 'users'
      and t.tgname = 'on_auth_user_created'
  ) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end
$$;

-- Bucket rows, transcribed from live storage.buckets. Their policies are in
-- 20260822130200_rls_storage_scalar_subqueries.sql and in section 4 above.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('receipt-images', 'receipt-images', true, 20971520),      -- 20 MiB
  ('photos',         'photos',         true, 53687091200)    -- 50 GiB
on conflict (id) do nothing;

