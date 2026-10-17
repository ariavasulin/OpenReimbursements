-- shop.refresh_jobs(): bring public.jobs up to date from the mirrored office tables.
-- The shop mirror calls it after every run. It follows the rules of the one-off
-- importer dws-app/scripts/import-jobs.mjs:
--   * open office jobs = tblProject rows whose number is on Sage's open list
--     (tblMas90JobMasterOpen, JobStatus 'O'), not Completed, not Archived;
--   * job_number is the office ProjectID; name is the trimmed project name;
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
-- A failure does not raise. The work is rolled back, an ok = false row with the
-- error is recorded, and { ok: false, error } is returned. A raised error would roll
-- back the failure row with everything else, and the admin's status view reads
-- sync_runs, so the caller must check ok.
create or replace function shop.refresh_jobs()
returns jsonb language plpgsql security definer set search_path = public, shop, pg_temp as $$
declare
  started timestamptz := clock_timestamp();
  upserted integer;
  skipped integer;
  dropped text[];
  result jsonb;
begin
  begin
    with open_jobs as (
      select p."ProjectID"::text as job_number,
             -- A blank office name falls back to the number; jobs.name is not null.
             coalesce(nullif(btrim(p."Project"), ''), p."ProjectID"::text) as name,
             -- Location text: tblLocation's LocationName, else "address, city".
             -- (import-jobs.mjs stored tblProject.Location, which is only the
             -- tblLocation id.) Change this one expression to show something else.
             coalesce(
               nullif(btrim(l."LocationName"), ''),
               nullif(concat_ws(', ', nullif(btrim(l."LocationAddress"), ''), nullif(btrim(l."LocationCity"), '')), '')
             ) as location
      from shop."tblProject" p
      join shop."tblMas90JobMasterOpen" m on m."JobNo" = p."ProjectID"
      left join shop."tblLocation" l on l."LocationID" = p."Location"
      where upper(btrim(m."JobStatus")) = 'O'
        and p."Completed" is null
        and not coalesce(p."Archived", false)
        and p."ProjectID"::text not like 'P-%'
    ),
    in_trash as (
      select o.job_number from open_jobs o
      join public.jobs t on t.job_number = o.job_number and t.deleted_at is not null
    ),
    written as (
      insert into public.jobs as target (job_number, name, location, is_active, synced_at)
      select o.job_number, o.name, o.location, true, now()
      from open_jobs o
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
                       and not exists (select 1 from open_jobs o where o.job_number = j.job_number)), '{}')
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
revoke execute on function shop.refresh_jobs() from public, anon, authenticated;
grant execute on function shop.refresh_jobs() to shop_mirror, service_role;
