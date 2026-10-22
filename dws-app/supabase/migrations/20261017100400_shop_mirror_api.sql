-- The shop bridge's way in: two functions the bridge box calls over Supabase's HTTPS
-- API (POST /rest/v1/rpc/<name>, with the project's public anon key). The box holds
-- no database login. What it can do is exactly what these two functions do:
--
--   public.shop_mirror_replace(p_token, p_table, p_columns, p_rows, p_error)
--     replace every row of shop.<p_table> with p_rows, creating the table on first
--     use; or, when p_error is set, record that the box could not read that table.
--   public.shop_mirror_refresh(p_token)
--     run shop.refresh_jobs() (20261017100200_shop_refresh_jobs.sql).
--
-- Both refuse (SQLSTATE 42501, HTTP 401/403) unless p_token's SHA-256 matches the one
-- row of shop.mirror_token (20261017100000_shop_schema.sql). Deleting that row
-- revokes the box. The anon key is public, so the token is the whole credential.
--
-- They run as postgres (security definer). That is safe because what the box sends is
-- only ever data: a table name and column names, quoted as identifiers; column types
-- from a fixed list of built-in types; and row values. So the box cannot create a view,
-- function, trigger, policy, or type in shop, and the tables it fills are owned by
-- postgres. The bridge's type map (shop-bridge/types.mjs) produces only the types
-- allowed here.
--
-- PostgREST runs anon's calls with Supabase's 3-second statement timeout for anon.
-- The shipped tables are small (contacts, the largest, is about 5,000 rows), well
-- within it.

create or replace function shop.require_mirror_token(p_token text)
returns void language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (
    select 1 from shop.mirror_token t where t.token_sha256 = sha256(convert_to(p_token, 'UTF8'))
  ) then
    raise exception 'shop mirror token refused' using errcode = '42501';
  end if;
end $$;
alter function shop.require_mirror_token(text) owner to postgres;
revoke execute on function shop.require_mirror_token(text) from public, anon, authenticated, service_role;

-- p_columns: [{ "name": "<column>", "type": "<type>" }, ...] in result order.
-- p_rows:    [{ "<column>": <value>, ... }, ...]; a missing key is null.
-- Returns { ok: true, row_count } or { ok: false, error }, and records the same in
-- shop.sync_runs. Like shop.refresh_jobs(), a failure inside the copy does not raise,
-- so its sync_runs row survives; only a refused token or an unusable table name raises.
create or replace function public.shop_mirror_replace(
  p_token text,
  p_table text,
  p_columns jsonb default null,
  p_rows jsonb default null,
  p_error text default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  started timestamptz := clock_timestamp();
  allowed constant text[] := array['integer', 'bigint', 'boolean', 'text', 'timestamp', 'numeric', 'double precision'];
  col jsonb;
  names text[] := '{}';
  defs text[] := '{}';
  existing text[];
  copied integer;
  failure text;
begin
  perform shop.require_mirror_token(p_token);
  if p_table is null or p_table !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$' or lower(p_table) in ('sync_runs', 'mirror_token') then
    raise exception 'shop_mirror_replace: % is not a mirror table name', coalesce(p_table, 'null') using errcode = '22023';
  end if;

  begin
    -- The box could not read the table: recorded below like any failed copy.
    if p_error is not null then
      raise exception '%', p_error;
    end if;
    if jsonb_typeof(p_columns) is distinct from 'array' or jsonb_array_length(p_columns) = 0 then
      raise exception 'p_columns must be a non-empty array of { name, type }';
    end if;
    if jsonb_typeof(p_rows) is distinct from 'array' then
      raise exception 'p_rows must be an array of row objects';
    end if;
    for col in select value from jsonb_array_elements(p_columns) loop
      if jsonb_typeof(col -> 'name') is distinct from 'string' or length(col ->> 'name') not between 1 and 63 then
        raise exception 'column name % is not 1 to 63 characters of text', coalesce(col ->> 'name', 'null');
      end if;
      if not ((col ->> 'type') = any (allowed)) then
        raise exception 'column % has type %, which is not one the mirror allows (%)',
          col ->> 'name', coalesce(col ->> 'type', 'null'), array_to_string(allowed, ', ');
      end if;
      names := names || (col ->> 'name');
      defs := defs || format('%I %s', col ->> 'name', col ->> 'type');
    end loop;

    execute format('create table if not exists shop.%I (%s)', p_table, array_to_string(defs, ', '));
    select array_agg(a.attname::text order by a.attnum) into existing
      from pg_attribute a
      where a.attrelid = format('shop.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped;
    if existing is distinct from names then
      raise exception 'landing table shop.% has columns % but the query returns %; drop table shop.% in Supabase and the next run recreates it',
        p_table, to_jsonb(existing), to_jsonb(names), p_table;
    end if;

    -- "where true": API calls run with pg-safeupdate, which refuses a bare DELETE.
    execute format('delete from shop.%I where true', p_table);
    execute format('insert into shop.%I select * from jsonb_populate_recordset(null::shop.%I, $1)', p_table, p_table)
      using p_rows;
    get diagnostics copied = row_count;

    insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok)
    values (p_table, started, clock_timestamp(), copied, true);
    return jsonb_build_object('ok', true, 'row_count', copied);
  exception when others then
    failure := left(sqlerrm, 500);
    insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok, error)
    values (p_table, started, clock_timestamp(), null, false, failure);
    return jsonb_build_object('ok', false, 'error', failure);
  end;
end $$;
alter function public.shop_mirror_replace(text, text, jsonb, jsonb, text) owner to postgres;
revoke execute on function public.shop_mirror_replace(text, text, jsonb, jsonb, text) from public, authenticated, service_role;
grant execute on function public.shop_mirror_replace(text, text, jsonb, jsonb, text) to anon;

create or replace function public.shop_mirror_refresh(p_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform shop.require_mirror_token(p_token);
  return shop.refresh_jobs();
end $$;
alter function public.shop_mirror_refresh(text) owner to postgres;
revoke execute on function public.shop_mirror_refresh(text) from public, authenticated, service_role;
grant execute on function public.shop_mirror_refresh(text) to anon;
