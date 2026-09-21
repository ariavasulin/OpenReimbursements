-- Sheet # is removed outright (plans/active/photo-albums/plan.md, Decision 6).
-- Second of two files: this one DROPS the column. The file before it
-- (20260920234921_photo_stop_writing_sheet_number.sql) already stopped the
-- database writing it.
--
-- WHEN TO APPLY: ONLY AFTER the deploy that stops reading the column is live.
--   Why this order (the opposite of the additive migrations): the app that is
--   live today names `sheet_number` in every photo query. Dropping the column
--   under it makes those queries fail, so the whole photo library would stop
--   loading until the new code deployed. The new code never names the column,
--   so once it is live the column is unused and safe to drop.
--   Rollback: before this file, revert the pull request. After it the column is
--   gone; bringing the field back would be new work.
--
-- WHAT CHANGES: index `photos_sheet` and column `photos.sheet_number` are
-- dropped, and the `authenticated` column grant is `update(tags)`. This file
-- re-creates NO function, on purpose: later migrations own the newest versions.
--
-- This file does NOT install the write boundary and does not touch a database
-- that has not been cut over beyond removing the column.
begin;

-- The plan's warrant for an irreversible drop is "no photo uses Sheet #"
-- (premise P1). Check it here, against the database actually being changed,
-- instead of trusting a count taken when the plan was written.
do $$ declare used bigint; begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='photos' and column_name='sheet_number') then
    execute 'select count(*) from public.photos where sheet_number is not null' into used;
    if used>0 then raise exception 'refusing to drop photos.sheet_number: % photo(s) still hold a value', used; end if;
  end if;
end $$;

-- The index covers (job_id, sheet_number) and would go with the column; named
-- here so the file says everything it removes.
drop index if exists public.photos_sheet;
alter table public.photos drop column if exists sheet_number;

-- Dropping the column already removed its column grant. State the remaining
-- one so the end result does not depend on what was granted before.
grant update(tags) on public.photos to authenticated;

-- Completeness check against the live database, not against the repo: if any
-- function still names the column (one this file missed, or one created by
-- hand), fail here and roll the whole file back rather than break at run time.
do $$ declare leftover text; begin
  select string_agg(p.oid::regprocedure::text,', ') into leftover from pg_proc p
    where p.pronamespace='public'::regnamespace and p.prosrc ilike '%sheet_number%';
  if leftover is not null then raise exception 'functions still name photos.sheet_number: %', leftover; end if;
end $$;
commit;
