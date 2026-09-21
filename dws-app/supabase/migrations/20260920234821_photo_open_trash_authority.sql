-- Any signed-in employee may trash and restore any photo
-- (plans/active/photo-albums/plan.md, Decision 7; user ruling 2026-09-20).
--
-- WHEN TO APPLY: BEFORE the pull request that removes the matching checks from
-- the app is merged.
--   Why this order: the new app no longer hides "Move to trash" / "Review
--   restore" from non-uploaders and no longer refuses them in the route. If it
--   went live first, those buttons would end in SQL `forbidden`.
--   Applying this first is safe for the app that is live today: nothing it does
--   starts failing. Note that the permission opens at THIS step, not at the
--   merge: the old confirm page (/photos/actions) relied on these SQL checks,
--   so from here an employee can already trash a colleague's photo through it.
--
-- WHAT CHANGES: the three action functions are re-created from their latest
-- definitions (20260907100400_photo_actions.sql) with exactly one statement
-- removed from each -- the `origin='ordinary'` uploader-or-administrator check.
-- Everything else is byte-for-byte the same and still applies to every caller:
--   * photo_assert_batch_actor: `photo_writes_enabled` gate, actor liveness
--     (profile not deleted, Auth user not deleted or banned), batch ownership
--     (only the employee who created the batch may act on it), and the MCP
--     hand-off binding (`mcp_enabled` gate plus a consumed hand-off whose script
--     matches the batch action);
--   * draft / materialization / approval state checks;
--   * trash consistency: expected job and deleted state, retention deadline,
--     purge claim, and the legacy-duplicate rules.
-- `deleted_by` still records who trashed the photo.
--
-- NOT CHANGED: photo_install_write_boundary and the identity-cutover functions
-- keep their role='admin' checks. They are deployment tools, not app features.
begin;

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
    insert into public.photo_action_items(batch_id,photo_id,expected_job_id,expected_deleted_at,requested_photo_id)
      values(p_batch_id,p.id,p.job_id,p.deleted_at,requested) on conflict do nothing;
  end loop;
  update public.photo_action_batches set materialization_cursor=p_next_cursor,materialization_complete=p_complete,updated_at=clock_timestamp() where id=p_batch_id;
end $$;

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
  update public.photo_action_batches set status='approved',approved_at=clock_timestamp(),approved_by=p_actor,updated_at=clock_timestamp() where id=p_batch_id;
end $$;

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
    if not ((b.action='trash' and p.deleted_at is not null and p.job_id=i.expected_job_id)
      or (b.action='move' and p.job_id=b.destination_job_id and p.deleted_at is not distinct from i.expected_deleted_at)
      or (b.action='restore' and p.deleted_at is null and i.expected_deleted_at is not null and p.job_id=coalesce(b.destination_job_id,i.expected_job_id))) then
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
      update public.photos set deleted_at=null,deleted_by=null,purge_after=null,job_id=coalesce(b.destination_job_id,p.job_id) where id=p_photo_id;
    end if;
  end if;
  v_result:=jsonb_build_object('status','applied','photo_id',p_photo_id,'action',b.action);
  update public.photo_action_items set status='applied',actor_id=p_actor,result=v_result,lease_generation=lease_generation+1,lease_expires_at=null,updated_at=instant where batch_id=p_batch_id and photo_id=p_photo_id;
  return v_result;
end $$;

-- `create or replace` keeps the existing ACL. Re-state it anyway so a rebuilt
-- database can never leave these callable by a browser credential. Scoped by
-- name on purpose: a blanket `photo_%` loop would hand
-- photo_record_upload_outcome back to service_role.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_materialize_action','photo_approve_action','photo_apply_action') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
