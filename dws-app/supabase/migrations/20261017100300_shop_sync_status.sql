-- public.shop_sync_status(): the newest shop.sync_runs row per table, for the admin
-- health route and the admin page's stale-sync warning
-- (supabaseAdmin.rpc('shop_sync_status')). It lives in public because PostgREST
-- exposes only public; the shop schema itself stays unexposed.
-- Returns a JSON array ordered by table name, [] before the first run:
--   [{ table, finished_at, row_count, ok, error, age_seconds, last_ok_at }]
-- last_ok_at is the newest successful run for that table, null if none ever was.
create or replace function public.shop_sync_status()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'table', r.table_name,
           'finished_at', r.finished_at,
           'row_count', r.row_count,
           'ok', r.ok,
           'error', r.error,
           'age_seconds', floor(extract(epoch from now() - r.finished_at))::integer,
           'last_ok_at', (select max(o.finished_at) from shop.sync_runs o
                          where o.table_name = r.table_name and o.ok)
         ) order by r.table_name), '[]'::jsonb)
  from (select distinct on (table_name) table_name, finished_at, row_count, ok, error
        from shop.sync_runs
        order by table_name, finished_at desc, id desc) r
$$;

alter function public.shop_sync_status() owner to postgres;
revoke execute on function public.shop_sync_status() from public, anon, authenticated;
grant execute on function public.shop_sync_status() to service_role;
