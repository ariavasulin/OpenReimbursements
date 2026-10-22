-- The shop mirror's home: a `shop` schema holding copies of query results from the
-- office SQL Server database, sent every 15 minutes by the service on the shop's
-- bridge box. PostgREST does not expose this schema, and anon and authenticated get
-- nothing in it; the apps read it with the service role.
--
-- The bridge box has no database login. It holds a mirror token and calls two
-- functions over Supabase's HTTPS API (20261017100400_shop_mirror_api.sql): one
-- replaces a mirror table's rows, the other refreshes public.jobs.
--
-- No migration creates the mirrored tables. The bridge's queries.json lists entries
-- { into, sql }; the first time an entry arrives, shop_mirror_replace creates
-- shop.<into> from the result's columns (all nullable, only the built-in types the
-- bridge maps to). After that it only replaces their rows; it never drops or alters
-- them.

create schema if not exists shop;
revoke all on schema shop from public;
revoke all on schema shop from anon, authenticated;
grant usage on schema shop to service_role;

-- Tables created in shop (by a migration, or by shop_mirror_replace, which runs as
-- postgres) can be read by the service role. Functions in shop are not callable by
-- everyone, which is otherwise Postgres's default.
alter default privileges in schema shop grant all on tables to service_role;
alter default privileges in schema shop revoke execute on functions from public;

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

revoke all on table shop.sync_runs from public, anon, authenticated;
grant all on table shop.sync_runs to service_role;

-- The SHA-256 of the bridge box's mirror token (SHOP_MIRROR_TOKEN in its .env). At
-- most one row, stored by the statement shop-bridge/install/setup.ps1 prints.
-- Deleting the row revokes the token: every call from the box is then refused.
create table if not exists shop.mirror_token (
  id boolean primary key default true check (id),
  token_sha256 bytea not null check (length(token_sha256) = 32),
  set_at timestamptz not null default now()
);
revoke all on table shop.mirror_token from public, anon, authenticated;
grant all on table shop.mirror_token to service_role;
