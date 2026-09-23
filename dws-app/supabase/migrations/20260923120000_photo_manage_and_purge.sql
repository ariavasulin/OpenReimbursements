-- Basic managing tools: rename a photo, renumber a project, delete and restore a
-- project, and delete trash forever (photos, albums, and projects) on request.
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching routes. Every change
-- only adds: three columns on jobs, one on albums, one on photos, new functions,
-- and re-created functions whose existing parameters keep their names, so the
-- app that is live today keeps working against this schema.
--
-- WHAT CHANGES, function by function, is listed above each one. Each re-created
-- function starts from its latest definition and changes only the named lines.
-- Any signed-in employee may do all of this, including deleting forever (owner's
-- decision, 2026-09-23). Grants are restated by name at the end.
begin;

-- A photo's name as people see it. original_name stays the uploaded filename:
-- MCP references and import matching address photos by it, so renaming never
-- touches it. Null means "show the uploaded filename".
alter table public.photos add column if not exists display_name text;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.photos'::regclass and conname='photos_display_name_check') then
    alter table public.photos add constraint photos_display_name_check check (display_name is null or
      (char_length(display_name) between 1 and 200 and display_name=btrim(display_name) and display_name !~ '[/\\]'));
  end if;
end $$;

-- Rename an active photo. NEW. Inner spaces collapse and the ends are trimmed; a
-- blank name clears it back to the uploaded filename. A function rather than a
-- session column grant: the write-boundary installer (20260920234921) resets
-- the employee's photo column grants to update(tags), which would drop one.
create or replace function public.photo_rename_photo(p_actor uuid,p_photo uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n text := nullif(btrim(regexp_replace(coalesce(p_name,''),'\s+',' ','g')),''); p public.photos;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if char_length(n)>200 or n ~ '[/\\]' then raise exception 'invalid_input'; end if;
  update public.photos set display_name=n where id=p_photo and deleted_at is null returning * into p;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('id',p.id,'display_name',p.display_name);
end $$;

-- A deleted project sits in Trash for 30 days, like an album. is_active goes
-- false with it, so every existing "project must be active" check (uploads,
-- moves, imports, share links, the project lists) already refuses it.
alter table public.jobs add column if not exists deleted_at timestamptz;
alter table public.jobs add column if not exists deleted_by uuid references auth.users(id);
-- Deleted forever. Upload, action, and import history keep foreign keys to the
-- project and their guards forbid editing them, so the row stays as a hidden
-- tombstone. Its number is released so a new project can use it again.
alter table public.jobs add column if not exists purged_at timestamptz;
-- The same for albums: import folders and share links keep pointing at the row.
alter table public.albums add column if not exists purged_at timestamptz;

-- The rule for a typed project number. NEW, internal. Trimmed; blank means none;
-- at most 32 characters; the P- namespace belongs to the generated codes.
create or replace function public.photo_job_number(p_number text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare num text := nullif(btrim(coalesce(p_number,'')),'');
begin
  if char_length(num)>32 or num ~* '^P-' then raise exception 'invalid_input'; end if;
  return num;
end $$;

-- A number already held by a project: 'job_in_trash' when that project is
-- deleted (restore it or delete it forever first), otherwise 'job_number_taken'.
-- NEW, internal. Returns quietly when the number is free.
create or replace function public.photo_assert_job_number_free(p_number text,p_except uuid default null)
returns void language plpgsql stable set search_path=public,pg_temp as $$
declare j public.jobs;
begin
  select * into j from public.jobs where job_number=p_number and id is distinct from p_except;
  if not found then return; end if;
  if j.deleted_at is not null then raise exception 'job_in_trash'; end if;
  raise exception 'job_number_taken';
end $$;

-- photo_create_job, from 20260920214954_photo_job_projects.sql.
-- CHANGED: the typed-number rule moves into photo_job_number; a typed number held
--   by a project in Trash is refused job_in_trash instead of handing back the
--   deleted project as 'exists'.
-- UNCHANGED: a live project with that number is still returned as 'exists'; the
--   generated P- code, the location rule, and the returned shape.
create or replace function public.photo_create_job(p_actor uuid,p_name text,p_job_number text default null,p_location text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; n text := public.photo_job_name(p_name);
  num text := public.photo_job_number(p_job_number); loc text := nullif(btrim(coalesce(p_location,'')),'');
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if char_length(loc)>200 then raise exception 'invalid_input'; end if;
  if num is not null then
    select * into j from public.jobs where job_number=num;
    if found and j.deleted_at is not null then raise exception 'job_in_trash'; end if;
    if found then return jsonb_build_object('status','exists','job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active)); end if;
  end if;
  insert into public.jobs(job_number,name,location,is_active,synced_at,created_by)
  values(coalesce(num,'P-'||nextval('public.job_project_code_seq')),n,loc,true,null,p_actor)
  on conflict(job_number) do nothing returning * into j;
  -- A concurrent create of the same typed number won the insert; report its row.
  if not found then select * into j from public.jobs where job_number=num;
    return jsonb_build_object('status','exists','job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active)); end if;
  return jsonb_build_object('status','created','job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active));
end $$;

-- photo_rename_job, from 20260920214954_photo_job_projects.sql.
-- CHANGED: new p_job_number (default null = keep the number). A new number follows
--   the create rule and must be free. A project in Trash cannot be renamed:
--   not_found, as for an unknown id. The old three-argument signature is dropped
--   in this transaction; the live app calls it by name without the new argument,
--   which the default keeps valid.
-- UNCHANGED: the name rule and the returned shape.
drop function if exists public.photo_rename_job(uuid,uuid,text);
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
  update public.jobs set name=n,job_number=coalesce(num,job_number) where id=p_job_id returning * into j;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active));
end $$;

-- Delete a project. NEW. The project and every active photo in it go to Trash
-- together, with one shared instant, so a restore can tell which photos left
-- with the project. Repeating a delete changes nothing and does not restart the
-- 30 days. Returns the project and how many photos went with it.
create or replace function public.photo_delete_job(p_actor uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; instant timestamptz; n integer := 0;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into j from public.jobs where id=p_job and purged_at is null for update;
  if not found then raise exception 'not_found'; end if;
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

-- Restore a project within 30 days of its deletion, with the photos that were
-- trashed together with it (same instant) and are still restorable. Photos
-- trashed on their own earlier stay in Trash. NEW.
create or replace function public.photo_restore_job(p_actor uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; instant timestamptz; n integer := 0;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into j from public.jobs where id=p_job and purged_at is null for update;
  if not found then raise exception 'not_found'; end if;
  if j.deleted_at is not null then
    instant:=clock_timestamp();
    if j.deleted_at+interval '30 days'<=instant then raise exception 'conflict'; end if;
    with restored as (
      update public.photos set deleted_at=null,deleted_by=null,purge_after=null
        where job_id=p_job and deleted_at=j.deleted_at and purge_after>instant and purge_claimed_at is null and duplicate_of is null
        returning 1)
    select count(*) into n from restored;
    update public.jobs set deleted_at=null,deleted_by=null,is_active=true where id=p_job returning * into j;
  end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active,'deleted_at',j.deleted_at),'restored',n);
end $$;

-- photo_restore_album, from 20260921024651_photo_albums.sql.
-- CHANGED: an album deleted forever is not_found, as if it never existed.
-- UNCHANGED: every other line.
create or replace function public.photo_restore_album(p_actor uuid,p_album uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into a from public.albums where id=p_album and purged_at is null for update;
  if not found then raise exception 'not_found'; end if;
  if a.deleted_at is not null then
    if a.deleted_at+interval '30 days'<=clock_timestamp() then raise exception 'conflict'; end if;
    update public.albums set deleted_at=null,deleted_by=null,updated_at=clock_timestamp() where id=p_album returning * into a;
  end if;
  return jsonb_build_object('album',to_jsonb(a));
end $$;

-- photo_apply_action, from 20260921024651_photo_albums.sql.
-- CHANGED: restoring a trashed photo whose project is deleted (in Trash or gone
--   forever) brings the photo back with no project, instead of into a project
--   nobody can see. Two lines: the trashed-photo restore, and the matching
--   "already applied elsewhere" test.
-- UNCHANGED: every other line.
create or replace function public.photo_apply_action(p_actor uuid,p_batch_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches; i public.photo_action_items; p public.photos; alias_photo public.photos; v_result jsonb; instant timestamptz;
begin
  select * into b from public.photo_action_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'action',b.action);
  if b.status not in ('approved','running','completed') or b.approved_by is distinct from p_actor then raise exception 'conflict'; end if;
  select * into i from public.photo_action_items where batch_id=p_batch_id and photo_id=p_photo_id for update;
  if not found then raise exception 'not_found'; end if;
  if i.status='applied' then return i.result; end if;
  if b.status='completed' or i.status in ('skipped','cancelled') then raise exception 'conflict'; end if;
  select * into p from public.photos where id=p_photo_id for update;
  if not found then raise exception 'not_found'; end if;
  -- Retention is evaluated after any lock wait, at the time we can mutate.
  instant:=clock_timestamp();
  if b.action='restore' and i.requested_photo_id is not null and i.requested_photo_id<>p_photo_id then
    select * into alias_photo from public.photos where id=i.requested_photo_id for share;
    instant:=clock_timestamp();
    if not found or alias_photo.duplicate_of is distinct from p_photo_id or alias_photo.deleted_at is null
      or alias_photo.purge_after is null or alias_photo.purge_after<=instant or alias_photo.purge_claimed_at is not null
    then raise exception 'conflict'; end if;
  end if;
  if (p.job_id,p.deleted_at) is distinct from (i.expected_job_id,i.expected_deleted_at) then
    -- A matching outcome applied through another confirmed request is idempotent.
    if not ((b.action='trash' and p.deleted_at is not null and p.job_id is not distinct from i.expected_job_id)
      or (b.action='move' and p.job_id is not distinct from b.destination_job_id and p.deleted_at is not distinct from i.expected_deleted_at)
      or (b.action='restore' and p.deleted_at is null and i.expected_deleted_at is not null and p.job_id is not distinct from
        coalesce(b.destination_job_id,(select j.id from public.jobs j where j.id=i.expected_job_id and j.deleted_at is null)))) then
      update public.photo_action_items set status='conflict',actor_id=p_actor,error=jsonb_build_object('code','conflict'),updated_at=instant where batch_id=p_batch_id and photo_id=p_photo_id;
      return jsonb_build_object('status','conflict','photo_id',p_photo_id);
    end if;
  else
    if b.destination_job_id is not null and not exists(select 1 from public.jobs where id=b.destination_job_id and is_active) then raise exception 'conflict'; end if;
    if b.action='trash' and p.deleted_at is null then
      update public.photos set deleted_at=instant,deleted_by=p_actor,purge_after=instant+interval '30 days' where id=p_photo_id;
    elsif b.action='move' then
      if p.deleted_at is not null then raise exception 'conflict'; end if;
      update public.photos set job_id=b.destination_job_id where id=p_photo_id;
    elsif b.action='restore' and p.deleted_at is null then
      update public.photos set job_id=coalesce(b.destination_job_id,p.job_id) where id=p_photo_id;
    elsif b.action='restore' and p.deleted_at is not null then
      if p.purge_after<=instant or p.purge_claimed_at is not null then raise exception 'conflict'; end if;
      -- Legacy duplicates never become independently active. The later resolver
      -- materializes the canonical target into its own exact confirmation.
      if p.duplicate_of is not null then raise exception 'conflict'; end if;
      update public.photos set deleted_at=null,deleted_by=null,purge_after=null,
        job_id=coalesce(b.destination_job_id,(select j.id from public.jobs j where j.id=p.job_id and j.deleted_at is null)) where id=p_photo_id;
    end if;
  end if;
  v_result:=jsonb_build_object('status','applied','photo_id',p_photo_id,'action',b.action);
  update public.photo_action_items set status='applied',actor_id=p_actor,result=v_result,lease_generation=lease_generation+1,lease_expires_at=null,updated_at=instant where batch_id=p_batch_id and photo_id=p_photo_id;
  return v_result;
end $$;

-- Delete forever. NEW. Three steps, so the files can be removed from Storage
-- between database calls, following the daily repair sweep's purge exactly:
--   1. photo_purge_request marks what goes: the named trashed photos, every
--      trashed photo of a named deleted project, the named deleted albums and
--      projects, or (p_everything) all of Trash. A marked photo is claimed
--      (purge_claimed_at), so it can no longer be restored and leaves the Trash
--      list; purge_after stays deleted_at + 30 days, as photos_trash_consistent
--      requires. Albums and projects become hidden tombstones at once.
--   2. photo_purge_authorize_delete fences each file path before the app removes it.
--   3. photo_purge_finish deletes the photo row once every file is confirmed gone.
-- The repair functions are unchanged: they need the repair lease, which this
-- request-driven path does not hold, and they stay the daily route's own.

-- Returns counts: photos marked (including ones already waiting), albums, projects.
-- A trashed legacy duplicate of a marked photo is marked with it, because the
-- photo it points at cannot be removed while it still points there.
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
  with targets as (
    select id from public.photos where deleted_at is not null and (p_everything or id=any(p_photo_ids) or job_id=any(target_jobs))
  ), with_copies as (
    select id from targets
    union select d.id from public.photos d join targets t on d.duplicate_of=t.id where d.deleted_at is not null
  ), marked as (
    update public.photos p set purge_claimed_at=coalesce(p.purge_claimed_at,instant)
      from with_copies w where p.id=w.id and p.deleted_at is not null returning 1)
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

-- The next marked photos to remove, copies first (a photo cannot go while a copy
-- still points at it), each with every file path it may own. Changes nothing,
-- but not STABLE: the gate check locks its row, which a read-only call cannot.
create or replace function public.photo_purge_pending(p_actor uuid,p_limit integer default 100)
returns table(id uuid,paths text[]) language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid_input'; end if;
  return query select p.id,public.photo_repair_paths(to_jsonb(p)) from public.photos p
    where p.deleted_at is not null and p.purge_claimed_at is not null
      and not exists(select 1 from public.photos r where r.duplicate_of=p.id)
    order by (p.duplicate_of is null),p.id limit p_limit;
end $$;

-- photo_repair_authorize_delete, from 20260907100500_photo_repair.sql, for a
-- marked photo. CHANGED: the repair lease checks become the write gate and a
-- signed-in actor; a photo path is required; the claim alone makes the photo
-- due (its 30 days need not have passed). UNCHANGED: every ownership check,
-- the path lock, and the permanent path fence.
create or replace function public.photo_purge_authorize_delete(p_actor uuid,p_path text,p_photo_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_path is null or p_path='' or length(p_path)>4096 or p_photo_id is null then raise exception 'invalid_input'; end if;
  select * into p from public.photos where id=p_photo_id for update;
  if not found or p.deleted_at is null or p.purge_claimed_at is null
    or exists(select 1 from public.photos where duplicate_of=p.id)
    or not (p_path=any(public.photo_repair_paths(to_jsonb(p)))) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('photo-path:'||p_path,0));
  if public.photo_repair_path_owned(p_path,p_photo_id) then return false; end if;
  insert into public.photo_repair_deleted_paths(path) values(p_path) on conflict do nothing;
  return true;
end $$;

-- photo_repair_finish_purge, from 20260907100500_photo_repair.sql, for a marked
-- photo. CHANGED: the repair lease checks become the write gate and a signed-in
-- actor; the claim alone makes the photo due. UNCHANGED: every file must be confirmed gone, the id is retired, and
-- only then is the row deleted.
create or replace function public.photo_purge_finish(p_actor uuid,p_photo_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos; v_path text;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  perform pg_advisory_xact_lock(hashtextextended('photo-upload-identity-reservation',0));
  select * into p from public.photos where id=p_photo_id for update;
  if not found then return false; end if;
  if p.deleted_at is null or p.purge_claimed_at is null
    or exists(select 1 from public.photos where duplicate_of=p.id) then return false; end if;
  foreach v_path in array array[p.original_path,p.thumb_path,p.preview_path,p.sidecar_path,p.playback_path] loop
    if v_path is null then continue; end if;
    perform pg_advisory_xact_lock(hashtextextended('photo-path:'||v_path,0));
    if not public.photo_repair_path_owned(v_path,p.id) then
      if not exists(select 1 from public.photo_repair_deleted_paths d where d.path=v_path)
        or exists(select 1 from storage.objects o where o.bucket_id='photos' and o.name=v_path) then return false; end if;
    end if;
  end loop;
  -- photo_action_items has no photo FK; migration history uses ON DELETE SET NULL.
  insert into public.photo_repair_retired_ids(id) values(p.id) on conflict do nothing;
  delete from public.photos where id=p.id;
  return true;
end $$;

-- Grants, by name.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_rename_photo','photo_create_job','photo_rename_job','photo_delete_job','photo_restore_job','photo_restore_album','photo_apply_action',
     'photo_purge_request','photo_purge_pending','photo_purge_authorize_delete','photo_purge_finish') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal helpers: only the functions above call them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_job_number','photo_assert_job_number_free') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
commit;
