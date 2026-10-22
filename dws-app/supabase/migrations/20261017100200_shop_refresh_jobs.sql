-- shop.refresh_jobs(): bring public.jobs up to date from the mirrored office data.
-- The bridge box calls it, through public.shop_mirror_refresh
-- (20261017100400_shop_mirror_api.sql), after every mirror run. It reads three tables
-- the mirror creates and fills (see 20261017100000_shop_schema.sql):
--   shop.projects  (ProjectID, Project, Completed, Archived, Location) from tblProject
--   shop.open_jobs (JobNo, JobStatus) from tblMas90JobMasterOpen
--   shop.locations (LocationID, LocationName, LocationAddress, LocationCity) from tblLocation
-- Those tables may not exist yet when this function is created or called: plpgsql
-- looks the names up when it runs, and a missing table is caught below as a failed run.
-- The rules:
--   * it refreshes only when the latest copy of each of those three tables succeeded
--     (its newest shop.sync_runs row is ok). Joining a fresh copy of one with a stale
--     copy of another could mark a closed job open, or blank a location. A failed
--     contacts copy does not stop it;
--   * open office jobs = shop.projects rows whose number is on Sage's open list
--     (shop.open_jobs, JobStatus 'O' in any case or spacing), not Completed, not Archived;
--   * a number listed more than once (a duplicate row in either office table) counts
--     once, since one upsert cannot write the same row twice;
--   * a row with synced_at set is an office job, and the photos app refuses to rename
--     or renumber it (20261022130000_photo_office_jobs.sql);
--   * a number held by a project in Trash is left alone and counted as skipped,
--     because writing is_active = true there would break jobs_deleted_not_active
--     (purged rows already had their number replaced, so deleted_at covers both);
--   * hand-made P- projects are never touched (office numbers are digits, so they
--     cannot collide; the where clauses say so anyway);
--   * nothing is ever set is_active = false. Jobs that were imported and are no
--     longer open are only listed, as dropped_from_open, until deactivation is decided.
-- The manual fallback, dws-app/scripts/import-jobs.mjs, differs: it stores
-- tblProject.Location (the bare location id) as location, does not check Completed,
-- and matches JobStatus 'O' case-sensitively. The next refresh rewrites what it wrote.
-- Each call writes one shop.sync_runs row under table_name 'public.jobs' and returns
-- the same jsonb: { ok, upserted, skipped_trashed, dropped_from_open }.
--
-- Only its owner, postgres, may call it. What it reads in shop is postgres-owned
-- tables holding only data the box sent (20261017100400_shop_mirror_api.sql); shop
-- stays off the search_path, so every shop name is written in full.
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
  stale text[];
begin
  begin
    select array_agg(t.name order by t.name) into stale
      from unnest(array['projects', 'locations', 'open_jobs']) as t(name)
      where not coalesce((select r.ok from shop.sync_runs r where r.table_name = t.name
                          order by r.finished_at desc, r.id desc limit 1), false);
    if stale is not null then
      raise exception 'not refreshed: the latest copy of shop.% did not succeed', array_to_string(stale, ', shop.');
    end if;

    with office_open as (
      select distinct on (p."ProjectID")
             p."ProjectID"::text as job_number,
             -- A blank office name falls back to the number; jobs.name is not null.
             coalesce(nullif(btrim(p."Project"), ''), p."ProjectID"::text) as name,
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
