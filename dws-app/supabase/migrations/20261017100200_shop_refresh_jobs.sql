-- shop.refresh_jobs(): bring public.jobs up to date from the mirrored office data.
-- The shop mirror calls it after every run. It reads three tables the bridge creates
-- and fills (see 20261017100000_shop_schema.sql):
--   shop.projects  (ProjectID, Project, Completed, Archived, Location) from tblProject
--   shop.open_jobs (JobNo, JobStatus) from tblMas90JobMasterOpen
--   shop.locations (LocationID, LocationName, LocationAddress, LocationCity) from tblLocation
-- Those tables may not exist yet when this function is created or called: plpgsql
-- looks the names up when it runs, and a missing table is caught below as a failed run.
-- It follows the rules of the manual-fallback importer dws-app/scripts/import-jobs.mjs:
--   * open office jobs = shop.projects rows whose number is on Sage's open list
--     (shop.open_jobs, JobStatus 'O'), not Completed, not Archived;
--   * job_number is the office ProjectID; name is the trimmed project name; a
--     number listed more than once (a duplicate row in either office table) counts
--     once, since one upsert cannot write the same row twice;
--   * upsert on job_number, setting name, location, is_active = true, synced_at;
--   * a number held by a project in Trash is left alone and counted as skipped,
--     because writing is_active = true there would break jobs_deleted_not_active
--     (purged rows already had their number replaced, so deleted_at covers both);
--   * hand-made P- projects are never touched (office numbers are digits, so they
--     cannot collide; the where clauses say so anyway);
--   * nothing is ever set is_active = false. Jobs that were imported and are no
--     longer open are only listed, as dropped_from_open, until deactivation is decided.
-- Each call writes one shop.sync_runs row under table_name 'public.jobs' and returns
-- the same jsonb: { ok, upserted, skipped_trashed, dropped_from_open }.
--
-- It runs with its caller's rights (security invoker), and only shop_mirror, the
-- bridge, may call it. shop_mirror owns the landing tables and can create objects in
-- shop, so it could swap a landing table for a view over its own function; a security
-- definer refresh would then run that function with the owner's rights and could copy
-- app tables out. Run as the caller, the function can do no more than shop_mirror
-- itself: read shop and read and upsert public.jobs (20261017100000_shop_schema.sql).
-- For the same reason shop is not on the search_path; every shop name is written in
-- full. In case a more privileged role ever calls it, it first locks the three landing
-- tables (so none can be swapped while it runs) and refuses to read one that is not a
-- plain table: a view, row level security or a policy, or a column whose type is not
-- built in can each run shop_mirror's own code as the caller.
--
-- A failure does not raise. The work is rolled back, an ok = false row with the
-- error is recorded, and { ok: false, error } is returned. A raised error would roll
-- back the failure row with everything else, and the admin's status view reads
-- sync_runs, so the caller must check ok.
create or replace function shop.refresh_jobs()
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  started timestamptz := clock_timestamp();
  upserted integer;
  skipped integer;
  dropped text[];
  result jsonb;
  landing text;
  rel record;
begin
  begin
    foreach landing in array array['projects', 'locations', 'open_jobs'] loop
      -- A missing table fails here, which is recorded as a failed run.
      execute format('lock table shop.%I in access share mode', landing);
      select c.relkind,
             c.relrowsecurity or exists (select 1 from pg_policy pol where pol.polrelid = c.oid) as rls,
             (select min(a.attname) from pg_attribute a join pg_type t on t.oid = a.atttypid
               where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 and t.typnamespace <> 'pg_catalog'::regnamespace) as odd_column
        into rel
        from pg_class c where c.oid = format('shop.%I', landing)::regclass;
      if rel.relkind <> 'r' then
        raise exception 'landing table shop.% is not a plain table', landing;
      elsif rel.rls then
        raise exception 'landing table shop.% is not a plain table: it has row level security or a policy', landing;
      elsif rel.odd_column is not null then
        raise exception 'landing table shop.% is not a plain table: column % has a type that is not built in', landing, rel.odd_column;
      end if;
    end loop;

    with office_open as (
      select distinct on (p."ProjectID")
             p."ProjectID"::text as job_number,
             -- A blank office name falls back to the number; jobs.name is not null.
             coalesce(nullif(btrim(p."Project"), ''), p."ProjectID"::text) as name,
             -- Location text: the location's LocationName, else "address, city".
             -- (import-jobs.mjs stored tblProject.Location, which is only the
             -- tblLocation id.) Change this one expression to show something else.
             coalesce(
               nullif(btrim(l."LocationName"), ''),
               nullif(concat_ws(', ', nullif(btrim(l."LocationAddress"), ''), nullif(btrim(l."LocationCity"), '')), '')
             ) as location
      from shop.projects p
      join shop.open_jobs m on m."JobNo" = p."ProjectID"
      left join shop.locations l on l."LocationID" = p."Location"
      where upper(btrim(m."JobStatus")) = 'O'
        and p."Completed" is null
        and not coalesce(p."Archived", false)
        and p."ProjectID"::text not like 'P-%'
      order by p."ProjectID", p."Project", l."LocationID"
    ),
    in_trash as (
      select o.job_number from office_open o
      join public.jobs t on t.job_number = o.job_number and t.deleted_at is not null
    ),
    written as (
      insert into public.jobs as target (job_number, name, location, is_active, synced_at)
      select o.job_number, o.name, o.location, true, now()
      from office_open o
      where not exists (select 1 from in_trash x where x.job_number = o.job_number)
      on conflict (job_number) do update
        set name = excluded.name, location = excluded.location, is_active = true, synced_at = excluded.synced_at
        -- Repeats the Trash and P- rules at the row, in case a project was
        -- deleted after in_trash was read.
        where target.deleted_at is null and target.job_number not like 'P-%'
      returning target.job_number
    )
    select (select count(*) from written),
           (select count(*) from in_trash),
           coalesce((select array_agg(j.job_number order by j.job_number) from public.jobs j
                     where j.synced_at is not null and j.is_active
                       and not exists (select 1 from office_open o where o.job_number = j.job_number)), '{}')
      into upserted, skipped, dropped;

    result := jsonb_build_object('ok', true, 'upserted', upserted, 'skipped_trashed', skipped,
                                 'dropped_from_open', to_jsonb(dropped));
    insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok, detail)
    values ('public.jobs', started, clock_timestamp(), upserted, true, result);
    return result;
  exception when others then
    result := jsonb_build_object('ok', false, 'error', sqlerrm);
    insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok, error, detail)
    values ('public.jobs', started, clock_timestamp(), null, false, sqlerrm, result);
    return result;
  end;
end $$;

alter function shop.refresh_jobs() owner to postgres;
revoke execute on function shop.refresh_jobs() from public, anon, authenticated, service_role;
grant execute on function shop.refresh_jobs() to shop_mirror;
