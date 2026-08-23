-- get_admin_receipts_page: carry the dashboard's search box and column sort.
--
-- Pagination moved server-side in 20260822150000 while the search box kept
-- filtering on the client, so the table searched one page while the totals,
-- the pager and the payroll CSV described the whole set.
--
-- New signature (the old five-argument overload is dropped first: PostgREST
-- cannot pick between overloads when the caller omits defaulted arguments):
--
--   search_term  case-insensitive substring over the employee's display name
--                (preferred_name, then full_name, then 'Unknown' — the same
--                fallback as employeeIdentity() in src/lib/types.ts) and the
--                description. null or '' means no search.
--   sort_field   one of date, employee, phone, amount, category, description;
--                null means the default order (receipt_date desc,
--                created_at desc), which is also every sort's tiebreak.
--   sort_dir     asc or desc; anything else is treated as asc.
--
-- The page CTE's ORDER BY puts nulls first ascending and last descending,
-- matching the client-side comparator this replaces.
--
-- service_role loses EXECUTE (the revoke is explicit because Supabase's
-- default privileges would otherwise grant it): is_admin() reads auth.uid(),
-- which a service-role JWT does not carry, so the function always raised for
-- it — a trap for whoever next moves the route onto supabaseAdmin.

drop function if exists public.get_admin_receipts_page(text, date, date, int, int);

create or replace function public.get_admin_receipts_page(
    status_filter text default null,
    from_date date default null,
    to_date date default null,
    page_num int default 1,
    page_size int default 25,
    search_term text default null,
    sort_field text default null,
    sort_dir text default null
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
declare
  term text := nullif(lower(trim(search_term)), '');
  dir  text := case when lower(sort_dir) = 'desc' then 'desc' else 'asc' end;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if sort_field is not null
     and sort_field not in ('date', 'employee', 'phone', 'amount', 'category', 'description') then
    raise exception 'invalid sort_field %', sort_field using errcode = '22023';
  end if;

  return query
  -- Status, dates and search are applied once, in `filtered`; `totals` and
  -- `page` both read from it, so the totals cannot drift out of step with the
  -- paged rows. Only user_profiles is joined here (the search needs the
  -- display name); phone and category are joined in the page path, where the
  -- sort needs them, so the totals never pay for them.
  with named as (
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
      up.full_name,
      up.preferred_name,
      up.employee_id_internal,
      coalesce(nullif(up.preferred_name, ''), nullif(up.full_name, ''), 'Unknown') as employee_name
    from public.receipts r
    left join public.user_profiles up on r.user_id = up.user_id
    where
      (status_filter is null or status_filter = 'all' or r.status = status_filter)
      and (from_date is null or r.receipt_date >= from_date)
      and (to_date is null or r.receipt_date < to_date)
  ),
  filtered as (
    select n.*
    from named n
    where term is null
      or position(term in lower(n.employee_name)) > 0
      or position(term in lower(coalesce(n.description, ''))) > 0
  ),
  totals as (
    select count(*) as total_count, coalesce(sum(f.amount), 0) as total_amount
    from filtered f
  ),
  page as (
    -- The subquery carries the sort; row_number() over its output pins that
    -- order so the outer join can restate it — a CTE's ORDER BY is not
    -- otherwise guaranteed to survive the join.
    select s.*, row_number() over () as rn
    from (
      select f.*, c.name as category_name, au.phone
      from filtered f
      left join auth.users au on f.user_id = au.id
      left join public.categories c on f.category_id = c.id
      order by
        -- One numeric and one text sort key, each split by direction so the
        -- whole ORDER BY stays static SQL and the field list stays a whitelist.
        (case when dir = 'asc'  and sort_field = 'amount' then f.amount end) asc  nulls first,
        (case when dir = 'desc' and sort_field = 'amount' then f.amount end) desc nulls last,
        (case when dir = 'asc' then
           case sort_field
             when 'date'        then f.receipt_date::text
             when 'employee'    then f.employee_name
             when 'phone'       then au.phone
             when 'category'    then c.name
             when 'description' then f.description
           end
         end) asc nulls first,
        (case when dir = 'desc' then
           case sort_field
             when 'date'        then f.receipt_date::text
             when 'employee'    then f.employee_name
             when 'phone'       then au.phone
             when 'category'    then c.name
             when 'description' then f.description
           end
         end) desc nulls last,
        f.receipt_date desc, f.created_at desc
      limit greatest(page_size, 1)
      offset greatest(page_num - 1, 0) * greatest(page_size, 1)
    ) s
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
  order by page.rn nulls last;
end;
$$;

comment on function public.get_admin_receipts_page(text, date, date, int, int, text, text, text) is
  'Paginated admin receipts listing with user profile data and phone numbers, filtered by status/date range/search term and ordered by a whitelisted sort field. total_count/total_amount aggregate the filtered set. Security definer for auth-schema access; raises "not authorized" unless public.is_admin(). An out-of-range page returns a single row whose receipt columns are null and which carries the totals — callers must skip rows with a null id.';

revoke all on function public.get_admin_receipts_page(text, date, date, int, int, text, text, text) from public, anon, service_role;
grant execute on function public.get_admin_receipts_page(text, date, date, int, int, text, text, text) to authenticated;
