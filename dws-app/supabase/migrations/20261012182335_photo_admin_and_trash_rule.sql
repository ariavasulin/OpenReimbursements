-- Photo admins and the delete rule (plans/active/dws-photos-client-feedback/
-- plan.md, Decisions 1 and 2; replaces photo-albums Decision 7).
--
-- A photo admin may trash any photo, delete forever, empty the trash, and
-- delete any project or album. Everyone else who is signed in may trash only
-- photos they uploaded in the last 30 days (photos.created_at, the upload time),
-- and delete only albums they created. Restore, tag, rename, move, album
-- membership, and creating or renaming projects and albums stay open to every
-- active employee.
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching routes and screens.
--   Applying first is safe for the app that is live today: the new column
--   defaults to false and nothing reads it yet. Note that the rule takes effect
--   at THIS step, not at the deploy: from here a non-admin who presses Empty
--   trash, project Delete, or Trash on a colleague's photo in the old app gets
--   "This action is not permitted." Set the photo admins right after applying
--   (Docs/photos-runbook.md, "Who may delete").
--
-- WHAT CHANGES:
--   * user_profiles.photo_admin, separate from the Receipts role column.
--   * The self-insert policy on user_profiles also refuses photo_admin=true, as
--     it already refuses role<>'employee'. The column update grant stays
--     update(full_name), so nobody can set the flag on themselves.
--   * Two internal helpers: photo_actor_is_admin and photo_can_trash.
--   * Re-created from their latest definitions, each changing only the line(s)
--     named above it. Grants are restated by name at the end.
--
-- NOT CHANGED: photo_install_write_boundary and the identity-cutover functions
-- keep their role='admin' checks. They are deployment tools, not app features.
begin;

alter table public.user_profiles add column if not exists photo_admin boolean not null default false;
comment on column public.user_profiles.photo_admin is
  'DWS Photos admin: may trash any photo, delete forever, empty the trash, and delete any project or album. Separate from role (Receipts).';

-- From 20260823120100_write_guards.sql. CHANGED: also requires photo_admin=false.
drop policy if exists user_profiles_insert_policy on public.user_profiles;
create policy user_profiles_insert_policy on public.user_profiles
  for insert
  with check (
    user_id = (select auth.uid())
    and role = 'employee'
    and not photo_admin
  );

-- Is this signed-in person a photo admin? NEW, internal. A deleted profile is not.
create or replace function public.photo_actor_is_admin(p_actor uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((select u.photo_admin from public.user_profiles u where u.user_id=p_actor and u.deleted_at is null),false);
$$;

-- The one delete rule. NEW, internal. A photo admin may trash any photo; anyone
-- else only a photo they uploaded within the last 30 days. To widen or narrow
-- who may trash, edit this function; this is the authority. The app keeps a copy
-- that must change with it: see the header of src/lib/photos/permissions.ts.
create or replace function public.photo_can_trash(p_actor uuid,p_photo public.photos)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(public.photo_actor_is_admin(p_actor)
    or (p_photo.uploader_id=p_actor and p_photo.created_at>now()-interval '30 days'),false);
$$;

-- photo_materialize_action, from 20260920234821_photo_open_trash_authority.sql.
-- CHANGED: one line: a trash batch refuses a photo the actor may not trash.
--   Every origin (ordinary and MCP).
-- UNCHANGED: every other line.
create or replace function public.photo_materialize_action(p_actor uuid,p_batch_id uuid,p_cursor text,p_ids uuid[],p_next_cursor text,p_complete boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches; requested uuid; p public.photos;
begin
  select * into b from public.photo_action_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'action');
  if b.status<>'draft' or b.materialization_complete or b.materialization_cursor is distinct from p_cursor then raise exception 'conflict'; end if;
  if cardinality(p_ids)>100 then raise exception 'invalid_input'; end if;
  foreach requested in array p_ids loop
    select * into p from public.photos where id=requested for share;
    if not found then raise exception 'conflict'; end if;
    if b.action='restore' and p.duplicate_of is not null then
      if p.purge_after is null or p.purge_after<=clock_timestamp() or p.purge_claimed_at is not null then raise exception 'conflict'; end if;
      select * into p from public.photos where id=p.duplicate_of for share;
      if not found or p.duplicate_of is not null then raise exception 'conflict'; end if;
    end if;
    if b.action='trash' and not public.photo_can_trash(p_actor,p) then raise exception 'forbidden'; end if;
    insert into public.photo_action_items(batch_id,photo_id,expected_job_id,expected_deleted_at,requested_photo_id)
      values(p_batch_id,p.id,p.job_id,p.deleted_at,requested) on conflict do nothing;
  end loop;
  update public.photo_action_batches set materialization_cursor=p_next_cursor,materialization_complete=p_complete,updated_at=clock_timestamp() where id=p_batch_id;
end $$;


-- photo_approve_action, from 20260920234821_photo_open_trash_authority.sql.
-- CHANGED: one statement: a trash batch holding a photo the actor may (no
--   longer) trash is refused.
-- UNCHANGED: every other line.
create or replace function public.photo_approve_action(p_actor uuid,p_batch_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches;
begin
  select * into b from public.photo_action_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'action',b.action);
  if b.status in ('approved','running','completed','interrupted') and b.approved_by=p_actor then return; end if;
  if b.status<>'draft' or not b.materialization_complete then raise exception 'conflict'; end if;
  if b.destination_job_id is not null and not exists(select 1 from public.jobs where id=b.destination_job_id and is_active) then raise exception 'invalid_input'; end if;
  if not exists(select 1 from public.photo_action_items where batch_id=p_batch_id) then raise exception 'invalid_input'; end if;
  if b.action='trash' and exists(select 1 from public.photo_action_items i join public.photos p on p.id=i.photo_id
    where i.batch_id=p_batch_id and not public.photo_can_trash(p_actor,p)) then raise exception 'forbidden'; end if;
  update public.photo_action_batches set status='approved',approved_at=clock_timestamp(),approved_by=p_actor,updated_at=clock_timestamp() where id=p_batch_id;
end $$;


-- photo_apply_action, from 20260923120000_photo_manage_and_purge.sql.
-- CHANGED: one line: trashing a photo the actor may (no longer) trash is
--   refused. photo_execute_action records it on the item as code 'forbidden',
--   so the confirm page can say why.
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
  if b.action='trash' and not public.photo_can_trash(p_actor,p) then raise exception 'forbidden'; end if;
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


-- photo_delete_job, from 20260923180000_photo_manage_followups.sql.
-- CHANGED: one line: only a photo admin may delete a project.
-- UNCHANGED: every other line.
create or replace function public.photo_delete_job(p_actor uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; instant timestamptz; n integer := 0;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
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


-- photo_delete_album, from 20260921024651_photo_albums.sql.
-- CHANGED: one line: only the album's creator or a photo admin may delete it.
-- UNCHANGED: every other line. Restore stays open to everyone.
create or replace function public.photo_delete_album(p_actor uuid,p_album uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into a from public.albums where id=p_album for update;
  if not found then raise exception 'not_found'; end if;
  if a.created_by is distinct from p_actor and not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
  if a.deleted_at is null then
    update public.albums set deleted_at=clock_timestamp(),deleted_by=p_actor,updated_at=clock_timestamp() where id=p_album returning * into a;
  end if;
  return jsonb_build_object('album',to_jsonb(a));
end $$;


-- Delete forever. Every photo_purge_* entry point requires a photo admin, so a
-- non-admin can neither mark nor finish removing anything.

-- photo_purge_request, from 20260923180000_photo_manage_followups.sql.
-- CHANGED: one line: photo admins only. UNCHANGED: every other line.
create or replace function public.photo_purge_request(p_actor uuid,p_photo_ids uuid[] default '{}',p_album_ids uuid[] default '{}',p_job_ids uuid[] default '{}',p_everything boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare instant timestamptz := clock_timestamp(); target_jobs uuid[]; target_albums uuid[]; n_photos integer; n_albums integer; n_jobs integer;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
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


-- photo_purge_pending, from 20260923180000_photo_manage_followups.sql.
-- CHANGED: one line: photo admins only. UNCHANGED: every other line.
create or replace function public.photo_purge_pending(p_actor uuid,p_limit integer default 100,p_exclude uuid[] default '{}')
returns table(id uuid,paths text[]) language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
  p_exclude:=coalesce(p_exclude,'{}');
  if p_limit is null or p_limit not between 1 and 500 or cardinality(p_exclude)>5000 then raise exception 'invalid_input'; end if;
  return query select p.id,public.photo_repair_paths(to_jsonb(p)) from public.photos p
    where p.deleted_at is not null and p.purge_claimed_at is not null
      and not (p.id=any(p_exclude))
      and not exists(select 1 from public.photos r where r.duplicate_of=p.id)
    order by (p.duplicate_of is null),p.id limit p_limit;
end $$;


-- photo_purge_authorize_delete, from 20260923120000_photo_manage_and_purge.sql.
-- CHANGED: one line: photo admins only. UNCHANGED: every other line.
create or replace function public.photo_purge_authorize_delete(p_actor uuid,p_path text,p_photo_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
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


-- photo_purge_finish, from 20260923120000_photo_manage_and_purge.sql.
-- CHANGED: one line: photo admins only. UNCHANGED: every other line.
create or replace function public.photo_purge_finish(p_actor uuid,p_photo_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos; v_path text;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
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


-- Grants, by name. Scoped by name on purpose: a blanket `photo_%` loop would
-- hand photo_record_upload_outcome back to service_role.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_materialize_action','photo_approve_action','photo_apply_action','photo_delete_job','photo_delete_album',
     'photo_purge_request','photo_purge_pending','photo_purge_authorize_delete','photo_purge_finish') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal helpers: only the functions above call them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_actor_is_admin','photo_can_trash') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
commit;
