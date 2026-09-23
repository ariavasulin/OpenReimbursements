-- Review follow-ups to 20260923120000_photo_manage_and_purge.sql, which is
-- already applied in production. Deleted projects must stay deleted, a purge
-- must always be able to finish what it marked, and a refused input must say why.
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching routes. Additive for
-- the live build: the one new check holds on every existing row (no project is
-- deleted in production yet), the new trigger only refuses writes into a deleted
-- project, and every re-created function keeps its callers' parameter names.
--
-- WHAT CHANGES is listed above each item. Grants are restated by name at the end.
begin;

-- A deleted project is never active. is_active is the flag every upload, move,
-- import, and picker guard reads, and scripts/import-jobs.mjs upserts
-- is_active=true on job_number, so without this a later import would reopen a
-- project sitting in Trash. This check makes any writer fail loudly instead of
-- reviving one.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.jobs'::regclass and conname='jobs_deleted_not_active') then
    alter table public.jobs add constraint jobs_deleted_not_active check (deleted_at is null or not is_active);
  end if;
end $$;

-- No live photo enters a deleted project. NEW. Upload finalize, moves, and the
-- same-photo rule check is_active without locking the project, so one that read
-- it just before photo_delete_job committed would otherwise attach a live photo
-- after the project's photos went to Trash. Locking the project row here waits
-- for a concurrent delete and then reads what it committed. Trashed rows (the
-- delete itself, a purge) are not checked.
create or replace function public.photo_guard_live_job()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare deleted timestamptz;
begin
  if new.job_id is null or new.deleted_at is not null then return new; end if;
  select j.deleted_at into deleted from public.jobs j where j.id=new.job_id for share;
  if deleted is not null then raise exception 'conflict'; end if;
  return new;
end $$;
drop trigger if exists photo_guard_live_job on public.photos;
create trigger photo_guard_live_job before insert or update of job_id on public.photos
  for each row execute function public.photo_guard_live_job();

-- photo_job_number, from 20260923120000. CHANGED: a typed P- code raises
-- job_number_reserved, so the person is told why. UNCHANGED: trimming, blank
-- means none, the 32-character limit (invalid_input).
create or replace function public.photo_job_number(p_number text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare num text := nullif(btrim(coalesce(p_number,'')),'');
begin
  if char_length(num)>32 then raise exception 'invalid_input'; end if;
  if num ~* '^P-' then raise exception 'job_number_reserved'; end if;
  return num;
end $$;

-- photo_rename_job, from 20260923120000. CHANGED: two renames racing to the same
-- free number: the loser's unique violation reads job_number_taken, not the
-- generic conflict. UNCHANGED: every other line.
create or replace function public.photo_rename_job(p_actor uuid,p_job_id uuid,p_name text,p_job_number text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; n text := public.photo_job_name(p_name); num text := nullif(btrim(coalesce(p_job_number,'')),'');
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into j from public.jobs where id=p_job_id and deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  -- Sending the current number back (a generated P- code included) keeps it;
  -- only a different number must obey the rule and be free.
  if num=j.job_number then num:=null; end if;
  if num is not null then num:=public.photo_job_number(num); perform public.photo_assert_job_number_free(num,j.id); end if;
  begin
    update public.jobs set name=n,job_number=coalesce(num,job_number) where id=p_job_id returning * into j;
  exception when unique_violation then raise exception 'job_number_taken';
  end;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active));
end $$;

-- photo_delete_job, from 20260923120000. CHANGED: only an active project can be
-- deleted. An office job the import left inactive is not_found here, so a restore
-- (which sets is_active true) can never reopen it. UNCHANGED: every other line.
create or replace function public.photo_delete_job(p_actor uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; instant timestamptz; n integer := 0;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into j from public.jobs where id=p_job and purged_at is null for update;
  if not found or (j.deleted_at is null and not j.is_active) then raise exception 'not_found'; end if;
  if j.deleted_at is null then
    instant:=clock_timestamp();
    update public.jobs set deleted_at=instant,deleted_by=p_actor,is_active=false where id=p_job returning * into j;
    with trashed as (
      update public.photos set deleted_at=instant,deleted_by=p_actor,purge_after=instant+interval '30 days'
        where job_id=p_job and deleted_at is null returning 1)
    select count(*) into n from trashed;
  end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active,'deleted_at',j.deleted_at),'trashed',n);
end $$;

-- photo_rename_photo, from 20260923120000. CHANGED: a name with a slash or over
-- 200 characters raises photo_name_invalid, so the person is told why.
-- UNCHANGED: every other line.
create or replace function public.photo_rename_photo(p_actor uuid,p_photo uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n text := nullif(btrim(regexp_replace(coalesce(p_name,''),'\s+',' ','g')),''); p public.photos;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if char_length(n)>200 or n ~ '[/\\]' then raise exception 'photo_name_invalid'; end if;
  update public.photos set display_name=n where id=p_photo and deleted_at is null returning * into p;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('id',p.id,'display_name',p.display_name);
end $$;

-- photo_purge_request, from 20260923120000. CHANGED: trashed legacy copies are
-- marked at every depth (A <- B <- C), not one level, since a photo cannot be
-- removed while any copy still points at it. UNCHANGED: every other line.
create or replace function public.photo_purge_request(p_actor uuid,p_photo_ids uuid[] default '{}',p_album_ids uuid[] default '{}',p_job_ids uuid[] default '{}',p_everything boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare instant timestamptz := clock_timestamp(); target_jobs uuid[]; target_albums uuid[]; n_photos integer; n_albums integer; n_jobs integer;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  p_photo_ids:=coalesce(p_photo_ids,'{}'); p_album_ids:=coalesce(p_album_ids,'{}'); p_job_ids:=coalesce(p_job_ids,'{}');
  if p_everything is null or cardinality(p_photo_ids)>500 or cardinality(p_album_ids)>500 or cardinality(p_job_ids)>500
    or (not p_everything and cardinality(p_photo_ids)+cardinality(p_album_ids)+cardinality(p_job_ids)=0) then raise exception 'invalid_input'; end if;
  -- Only what is already in Trash can be deleted forever. Lock in id order.
  select coalesce(array_agg(id order by id),'{}') into target_jobs from (select id from public.jobs
    where deleted_at is not null and purged_at is null and (p_everything or id=any(p_job_ids)) order by id for update) j;
  select coalesce(array_agg(id order by id),'{}') into target_albums from (select id from public.albums
    where deleted_at is not null and purged_at is null and (p_everything or id=any(p_album_ids)) order by id for update) a;
  with recursive targets as (
    select id from public.photos where deleted_at is not null and (p_everything or id=any(p_photo_ids) or job_id=any(target_jobs))
    union
    select d.id from public.photos d join targets t on d.duplicate_of=t.id where d.deleted_at is not null
  ), marked as (
    update public.photos p set purge_claimed_at=coalesce(p.purge_claimed_at,instant)
      from targets w where p.id=w.id and p.deleted_at is not null returning 1)
  select count(*) into n_photos from marked;
  -- Tombstones. The number goes to 'deleted:<id>', which no typed number can be
  -- (32 characters at most), so the real number is free for a new project.
  update public.jobs set purged_at=instant,job_number='deleted:'||id::text where id=any(target_jobs);
  n_jobs:=cardinality(target_jobs);
  update public.albums set purged_at=instant,updated_at=instant where id=any(target_albums);
  delete from public.album_photos where album_id=any(target_albums);
  n_albums:=cardinality(target_albums);
  update public.photo_share_links set revoked_at=instant,revoked_by=p_actor
    where revoked_at is null and (job_id=any(target_jobs) or album_id=any(target_albums));
  return jsonb_build_object('photos',n_photos,'albums',n_albums,'projects',n_jobs);
end $$;

-- photo_purge_pending, from 20260923120000. CHANGED: new p_exclude, the ids that
-- already failed in this request, so a page of persistent Storage failures can no
-- longer hide the marked photos behind it. The signature changes, so the old one
-- is dropped; only the purge route (not yet deployed) calls it.
drop function if exists public.photo_purge_pending(uuid,integer);
create or replace function public.photo_purge_pending(p_actor uuid,p_limit integer default 100,p_exclude uuid[] default '{}')
returns table(id uuid,paths text[]) language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  p_exclude:=coalesce(p_exclude,'{}');
  if p_limit is null or p_limit not between 1 and 500 or cardinality(p_exclude)>5000 then raise exception 'invalid_input'; end if;
  return query select p.id,public.photo_repair_paths(to_jsonb(p)) from public.photos p
    where p.deleted_at is not null and p.purge_claimed_at is not null
      and not (p.id=any(p_exclude))
      and not exists(select 1 from public.photos r where r.duplicate_of=p.id)
    order by (p.duplicate_of is null),p.id limit p_limit;
end $$;

-- Deleted projects for the Trash page. NEW. Every project in Trash, however old,
-- until it is deleted forever: after its 30 days it can no longer be restored but
-- must stay reachable, since it still holds its number. photo_count is what a
-- restore brings back: the photos trashed at the same instant and not yet marked.
create or replace function public.photo_deleted_jobs(p_limit integer default 500)
returns jsonb language sql stable set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(d) order by d.deleted_at desc,d.id),'[]'::jsonb) from (
    select j.id,j.job_number,j.name,j.deleted_at,j.deleted_by,j.deleted_at+interval '30 days' as restore_before,
      (select count(*) from public.photos p where p.job_id=j.id and p.deleted_at=j.deleted_at and p.purge_claimed_at is null) as photo_count
    from public.jobs j where j.deleted_at is not null and j.purged_at is null
    order by j.deleted_at desc,j.id limit greatest(1,least(coalesce(p_limit,500),1000))
  ) d;
$$;

-- Grants, by name.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_rename_job','photo_delete_job','photo_rename_photo','photo_purge_request','photo_purge_pending','photo_deleted_jobs') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal: only triggers and the functions above call them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_job_number','photo_guard_live_job') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
commit;
