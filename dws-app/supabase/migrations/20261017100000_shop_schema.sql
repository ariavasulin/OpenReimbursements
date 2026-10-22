-- The shop mirror's home: a `shop` schema holding copies of query results from the
-- office SQL Server database, written every 15 minutes by the service on the shop's
-- bridge box (plans/active/shop-db-bridge/plan.md). PostgREST does not expose this
-- schema, and anon and authenticated get nothing in it; the apps read it with the
-- service role.
--
-- No migration creates the mirrored tables. The bridge's config lists entries
-- { into, sql }; on its first run the bridge creates shop.<into> itself
-- (create table if not exists, all columns nullable, named exactly as the result
-- set), so those tables are owned by shop_mirror. After that it only replaces
-- their rows; it never drops or alters them.
--
-- The bridge box connects as its own login role, shop_mirror. It can create, fill,
-- and read tables in this schema, call shop.refresh_jobs(), and read and upsert
-- public.jobs (select, insert, update; no delete), and nothing else: no other public
-- table, nothing in auth, and membership in no other role. refresh_jobs() runs with
-- its caller's rights, so the public.jobs grant and policy below are what it uses
-- when the bridge calls it.
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
grant usage, create on schema shop to shop_mirror;

-- Tables a migration creates in shop get these grants by default (each migration
-- still grants explicitly). Functions in shop are not callable by everyone, which is
-- otherwise Postgres's default.
alter default privileges in schema shop grant all on tables to service_role;
alter default privileges in schema shop revoke execute on functions from public;

-- The tables the bridge creates are owned by shop_mirror, so the lines above do not
-- reach them. This does: the apps read them with the service role. Only a member of
-- shop_mirror may set its default privileges, so postgres (which applies migrations)
-- joins it for this statement and leaves. Name the role: `grant ... to current_user`
-- crashes the Supabase Postgres 15 backend (signal 11, seen on the local image).
-- postgres gets no such grant: nothing that runs as postgres reads these tables.
grant shop_mirror to postgres;
alter default privileges for role shop_mirror in schema shop grant all on tables to service_role;
revoke shop_mirror from postgres;

-- What shop.refresh_jobs() needs on public.jobs when the bridge calls it as
-- shop_mirror: read, insert, and update (the upsert), never delete. public.jobs has
-- row level security and its only other policy is for authenticated, so shop_mirror
-- gets its own. The grant, not the policy, is what keeps out delete. The table's
-- defaults (gen_random_uuid(), now()) use no sequence.
grant select, insert, update on table public.jobs to shop_mirror;
drop policy if exists jobs_shop_mirror on public.jobs;
create policy jobs_shop_mirror on public.jobs
  for all to shop_mirror using (true) with check (true);

-- One row per mirror entry per run, under table_name = the entry's `into` name
-- ('projects', 'contacts', ...), plus one per shop.refresh_jobs() call under
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
