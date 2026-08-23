-- Paginated sibling of get_admin_receipts_with_phone. The SELECT body — column
-- list, joins, filters, and ordering — is copied verbatim from the baseline
-- capture of that function (00000000000000_baseline.sql), including the
-- EXCLUSIVE to_date bound (r.receipt_date < to_date; the dashboard passes
-- to+1day for inclusive ranges). It adds only:
--   * a bounded page (limit/offset from page_num/page_size), and
--   * total_count / total_amount over the whole filtered set, so the caller
--     gets the filtered totals without a second query.
--
-- Superseded by 20260823120000_admin_receipts_page_search_sort.sql, which
-- drops and re-creates the function with search and sort.
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
  return query
  with totals as (
    select count(*) as total_count, sum(r.amount) as total_amount
    from public.receipts r
    where
      (status_filter is null or status_filter = 'all' or r.status = status_filter)
      and (from_date is null or r.receipt_date >= from_date)
      and (to_date is null or r.receipt_date < to_date)
  ),
  page as (
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
      r.updated_at,
      c.name as category_name,
      up.full_name,
      up.preferred_name,
      up.employee_id_internal,
      au.phone
    from public.receipts r
    left join public.user_profiles up on r.user_id = up.user_id
    left join auth.users au on r.user_id = au.id
    left join public.categories c on r.category_id = c.id
    where
      (status_filter is null or status_filter = 'all' or r.status = status_filter)
      and (from_date is null or r.receipt_date >= from_date)
      and (to_date is null or r.receipt_date < to_date)
    order by r.receipt_date desc, r.created_at desc
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
  from page
  cross join totals
  order by page.receipt_date desc, page.created_at desc;
end;
$$;

comment on function public.get_admin_receipts_page(text, date, date, int, int) is
  'Paginated admin receipts listing with user profile data and phone numbers. Same body as get_admin_receipts_with_phone plus a bounded page and total_count/total_amount aggregated over public.receipts alone. Security definer allows access to the auth schema; the API route enforces the admin gate.';

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon directly (not via
-- PUBLIC), so it must be revoked by name as well.
revoke all on function public.get_admin_receipts_page(text, date, date, int, int) from public;
revoke all on function public.get_admin_receipts_page(text, date, date, int, int) from anon;
grant execute on function public.get_admin_receipts_page(text, date, date, int, int) to authenticated, service_role;
