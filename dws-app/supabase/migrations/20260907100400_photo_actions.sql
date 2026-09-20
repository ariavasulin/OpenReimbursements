-- Exact, bounded action drafts; all functions are service-only after verified Auth.
begin;
alter table public.photo_action_batches drop constraint if exists photo_action_batches_origin_check;
alter table public.photo_action_batches add constraint photo_action_batches_origin_check check(origin in ('mcp','ui','ordinary'));
-- Expansion has no production action batches; retain any earlier test/operator drafts.
alter table public.photo_action_batches disable trigger photo_guard_batch_contract;
update public.photo_action_batches set origin='ordinary' where origin='ui' and action<>'move';
alter table public.photo_action_batches enable trigger photo_guard_batch_contract;
alter table public.photo_action_batches drop constraint if exists photo_ui_move_only;
alter table public.photo_action_batches add constraint photo_ui_move_only check(origin<>'ui' or action='move');
alter table public.photo_action_batches add column if not exists materialization_complete boolean not null default false;
alter table public.photo_action_batches add column if not exists materialization_cursor text;
alter table public.photo_action_items add column if not exists requested_photo_id uuid;

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
    if b.origin='ordinary' and p.uploader_id is distinct from p_actor and not exists(select 1 from public.user_profiles where user_id=p_actor and role='admin') then raise exception 'forbidden'; end if;
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
  if b.origin='ordinary' and not exists(select 1 from public.user_profiles where user_id=p_actor and role='admin') and exists(
    select 1 from public.photo_action_items i join public.photos p on p.id=i.photo_id where i.batch_id=p_batch_id and p.uploader_id is distinct from p_actor)
  then raise exception 'forbidden'; end if;
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
  if b.origin='ordinary' and p.uploader_id<>p_actor and not exists(select 1 from public.user_profiles where user_id=p_actor and role='admin') then raise exception 'forbidden'; end if;
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


-- One short transaction per bounded apply request. Subtransactions preserve each
-- conflict without rolling back unrelated targets or obscuring the replay result.
create or replace function public.photo_execute_action(p_actor uuid,p_batch_id uuid,p_photo_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches; target uuid; outcome jsonb; outcomes jsonb:='[]'; code text;
begin
  select * into b from public.photo_action_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'action');
  if b.status not in ('approved','running','interrupted','completed') or b.approved_by is distinct from p_actor then raise exception 'conflict'; end if;
  if cardinality(p_photo_ids)<1 or cardinality(p_photo_ids)>100 then raise exception 'invalid_input'; end if;
  if exists(select 1 from unnest(p_photo_ids) id where not exists(select 1 from public.photo_action_items where batch_id=p_batch_id and photo_id=id)) then raise exception 'not_found'; end if;
  if b.status<>'completed' then update public.photo_action_batches set status='running' where id=p_batch_id; end if;
  foreach target in array p_photo_ids loop
    begin
      outcome:=public.photo_apply_action(p_actor,p_batch_id,target);
    exception when raise_exception then
      code:=sqlerrm;
      if code not in ('conflict','not_found','forbidden') then raise; end if;
      update public.photo_action_items set status='conflict',actor_id=p_actor,error=jsonb_build_object('code',code),updated_at=clock_timestamp()
        where batch_id=p_batch_id and photo_id=target and status not in ('applied','skipped','cancelled');
      outcome:=jsonb_build_object('status','conflict','photo_id',target,'code',code);
    end;
    outcomes:=outcomes||jsonb_build_array(outcome);
  end loop;
  update public.photo_action_batches set status=case
    when not exists(select 1 from public.photo_action_items where batch_id=p_batch_id and status not in ('applied','skipped')) then 'completed'
    when exists(select 1 from public.photo_action_items where batch_id=p_batch_id and status in ('conflict','retryable_failed')) then 'interrupted'
    else 'running' end,updated_at=clock_timestamp() where id=p_batch_id;
  return outcomes;
end $$;

create or replace function public.photo_action_control(p_actor uuid,p_batch_id uuid,p_action text,p_photo_ids uuid[] default '{}')
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches;
begin
  select * into b from public.photo_action_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'action');
  if p_action='cancel' then
    if b.status='completed' then raise exception 'conflict'; end if;
    update public.photo_action_items set status='cancelled',updated_at=clock_timestamp() where batch_id=p_batch_id and status not in ('applied','skipped');
    update public.photo_action_batches set status='cancelled',updated_at=clock_timestamp() where id=p_batch_id;
  elsif p_action='skip' then
    if b.status not in ('approved','running','interrupted') or cardinality(p_photo_ids)<1 or cardinality(p_photo_ids)>100 then raise exception 'conflict'; end if;
    update public.photo_action_items set status='skipped',actor_id=p_actor,updated_at=clock_timestamp() where batch_id=p_batch_id and photo_id=any(p_photo_ids) and status not in ('applied','cancelled');
    if not exists(select 1 from public.photo_action_items where batch_id=p_batch_id and status not in ('applied','skipped')) then
      update public.photo_action_batches set status='completed',updated_at=clock_timestamp() where id=p_batch_id;
    end if;
  else raise exception 'invalid_input'; end if;
end $$;

create or replace function public.photo_guard_action_targets()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare state text; batch uuid;
begin
  batch:=case when tg_op='DELETE' then old.batch_id else new.batch_id end;
  select status into state from public.photo_action_batches where id=batch for update;
  if tg_op in ('INSERT','DELETE') and state<>'draft' then raise exception 'conflict'; end if;
  if tg_op='UPDATE' and (new.batch_id,new.photo_id,new.expected_job_id,new.expected_deleted_at,new.requested_photo_id) is distinct from
    (old.batch_id,old.photo_id,old.expected_job_id,old.expected_deleted_at,old.requested_photo_id) then raise exception 'conflict'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;

-- Retain exact draft metadata after approval as well as target membership.
create or replace function public.photo_guard_batch_contract()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.created_by,new.origin,new.action) is distinct from (old.created_by,old.origin,old.action)
    or (old.status<>'draft' and (new.selector,new.destination_job_id,new.approved_by,new.approved_at,new.materialization_cursor,new.materialization_complete) is distinct from (old.selector,old.destination_job_id,old.approved_by,old.approved_at,old.materialization_cursor,old.materialization_complete))
  then raise exception 'conflict'; end if;
  if new.status='draft' and old.status<>'draft' then raise exception 'conflict'; end if;
  if new.status='completed' and exists(select 1 from public.photo_action_items where batch_id=new.id and status not in ('applied','skipped')) then raise exception 'conflict'; end if;
  return new;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_materialize_action','photo_approve_action','photo_apply_action','photo_execute_action','photo_action_control','photo_guard_batch_contract','photo_guard_action_targets') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
