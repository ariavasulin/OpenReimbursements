-- The shop mirror's home: a `shop` schema holding copies of tables from the office
-- SQL Server database, written every 15 minutes by the service on the shop's bridge
-- box (plans/active/shop-db-bridge/plan.md). PostgREST does not expose this schema,
-- and anon and authenticated get nothing in it; the apps read it with the service role.
--
-- The bridge box connects as its own login role, shop_mirror, which can write only
-- this schema and call shop.refresh_jobs(). It gets no grants on public tables and
-- is a member of no other role.
--
-- No password is set here. Supabase's pooler only lets a role log in once it has
-- one, so the operator sets it out of band, once, after applying this file:
--   alter role shop_mirror password '<generated secret>';
-- and records where the secret is kept (see the shop bridge runbook).

create schema if not exists shop;
revoke all on schema shop from public;
revoke all on schema shop from anon, authenticated;
grant usage on schema shop to service_role, postgres;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'shop_mirror') then
    create role shop_mirror login;
  end if;
end $$;
grant usage on schema shop to shop_mirror;

-- Tables created here later (the generated mirror tables) get these grants by default;
-- each migration still grants explicitly. Functions in shop are not callable by
-- everyone, which is otherwise Postgres's default.
alter default privileges in schema shop grant select, insert, delete on tables to shop_mirror;
alter default privileges in schema shop grant all on tables to service_role;
alter default privileges in schema shop revoke execute on functions from public;

-- One row per mirrored table per run, plus one per shop.refresh_jobs() call under
-- table_name = 'public.jobs'. The admin reads the latest per table with the service role.
create table if not exists shop.sync_runs (
  id bigint generated always as identity primary key,
  table_name text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  row_count integer,
  ok boolean not null,
  error text,
  detail jsonb
);
create index if not exists sync_runs_table_finished on shop.sync_runs (table_name, finished_at desc);

revoke all on table shop.sync_runs from public, anon, authenticated, shop_mirror;
grant select, insert on table shop.sync_runs to shop_mirror;
grant all on table shop.sync_runs to service_role;
