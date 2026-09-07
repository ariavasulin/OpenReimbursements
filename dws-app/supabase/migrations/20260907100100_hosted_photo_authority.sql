-- Service-only transactional boundaries. This migration defines the operator
-- cutover helper but deliberately does not invoke it or build the global index.
begin;
create or replace function public.photo_require_gate(p_gate text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.photo_release_state where singleton and schema_generation=1 and
    case p_gate when 'writes' then photo_writes_enabled when 'mcp' then mcp_enabled when 'repair' then repair_enabled else false end for share)
  then raise exception 'photo_gate_closed'; end if;
end $$;
create or replace function public.photo_require_actor(p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_actor is null or not exists(select 1 from public.user_profiles p join auth.users u on u.id=p.user_id
    where p.user_id=p_actor and p.deleted_at is null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
  then raise exception 'invalid_actor'; end if;
end $$;
create or replace function public.consume_dws_handoff(p_token_digest text,p_actor uuid,p_script text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.dws_action_handoffs; b uuid; destination uuid;
begin
  perform public.photo_require_gate('mcp'); perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into h from public.dws_action_handoffs where token_digest=p_token_digest for update;
  if not found then raise exception 'not_found'; end if;
  if h.script_name is distinct from p_script then raise exception 'wrong_script'; end if;
  if h.consumed_at is not null then raise exception 'handoff_consumed'; end if;
  if h.expires_at<=clock_timestamp() then raise exception 'handoff_expired'; end if;
  if h.script_name in ('migrate_photos','add_photos') then
    insert into public.migration_batches(created_by,origin,script_name) values(p_actor,'mcp',h.script_name) returning id into b;
    update public.dws_action_handoffs set consumed_at=clock_timestamp(),consumed_by=p_actor,migration_batch_id=b where id=h.id;
    return jsonb_build_object('migration_batch_id',b,'photo_action_batch_id',null,'script_name',h.script_name);
  end if;
  if h.requested_input->>'destination_job_number' is not null then
    select id into destination from public.jobs where job_number=h.requested_input->>'destination_job_number' and is_active;
    if not found then raise exception 'invalid_input'; end if;
  end if;
  insert into public.photo_action_batches(created_by,origin,action,selector,destination_job_id)
  values(p_actor,'mcp',case h.script_name when 'move_photos' then 'move' when 'remove_photos' then 'trash' else 'restore' end,
    coalesce(h.requested_input->'selector','{}'),destination) returning id into b;
  update public.dws_action_handoffs set consumed_at=clock_timestamp(),consumed_by=p_actor,photo_action_batch_id=b where id=h.id;
  return jsonb_build_object('migration_batch_id',null,'photo_action_batch_id',b,'script_name',h.script_name);
end $$;
create or replace function public.photo_assert_batch_actor(p_actor uuid,p_batch_id uuid,p_kind text,p_action text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare creator uuid; origin_kind text; expected_script text; actual_action text;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_kind='migration' then
    select created_by,origin,script_name into creator,origin_kind,expected_script from public.migration_batches where id=p_batch_id;
  elsif p_kind='action' then
    select created_by,origin,action into creator,origin_kind,actual_action from public.photo_action_batches where id=p_batch_id;
    expected_script:=case actual_action when 'move' then 'move_photos' when 'trash' then 'remove_photos' when 'restore' then 'restore_photos' end;
    if p_action is not null and p_action is distinct from actual_action then raise exception 'wrong_script'; end if;
  else raise exception 'invalid_input'; end if;
  if creator is null then raise exception 'not_found'; end if;
  if creator<>p_actor then raise exception 'wrong_consumer'; end if;
  if origin_kind='mcp' then
    perform public.photo_require_gate('mcp');
    if not exists(select 1 from public.dws_action_handoffs where consumed_by=p_actor and consumed_at is not null and script_name=expected_script
      and ((p_kind='migration' and migration_batch_id=p_batch_id) or (p_kind='action' and photo_action_batch_id=p_batch_id)))
    then raise exception 'wrong_script'; end if;
  end if;
end $$;

-- Lock order throughout: batch, owner, digest. Cancellation uses the same order.
create or replace function public.photo_lock_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; batch uuid; batch_status text; job uuid;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_owner_kind='ordinary' then
    select to_jsonb(a) into v from public.photo_upload_attempts a where id=p_owner_id for update;
    if v is null then raise exception 'not_found'; end if;
    if (v->>'actor_id')::uuid<>p_actor then raise exception 'wrong_consumer'; end if;
  elsif p_owner_kind='migration' then
    select s.batch_id,s.job_id into batch,job from public.migration_items i join public.migration_sources s on s.id=i.source_id where i.id=p_owner_id;
    select status into batch_status from public.migration_batches where id=batch for update;
    perform public.photo_assert_batch_actor(p_actor,batch,'migration');
    select to_jsonb(i) || jsonb_build_object('actor_id',p_actor,'job_id',job) into v from public.migration_items i where i.id=p_owner_id for update;
    if not (v->>'is_current')::boolean then raise exception 'conflict'; end if;
    if batch_status not in ('approved','running') and not coalesce((v->>'status' in ('completed','skipped_duplicate') and v->'result'<>'null'::jsonb),false) then raise exception 'conflict'; end if;
  else raise exception 'invalid_input'; end if;
  if v->>'status'='cancelled' then raise exception 'conflict'; end if;
  return v;
end $$;
create or replace function public.photo_storage_filename(p_name text)
returns text language plpgsql immutable security definer set search_path=public,pg_temp as $$
declare dot integer:=length(p_name)-strpos(reverse(p_name),'.')+1; base text:=p_name; ext text:='';
begin
  if strpos(p_name,'.')>0 and dot>1 then base:=left(p_name,dot-1); ext:=substr(p_name,dot+1); end if;
  base:=trim(both '_' from regexp_replace(normalize(base,NFKD),'[^A-Za-z0-9_-]+','_','g'));
  ext:=trim(both '_' from regexp_replace(normalize(ext,NFKD),'[^A-Za-z0-9_-]+','_','g'));
  base:=regexp_replace(base,'_+','_','g'); ext:=regexp_replace(ext,'_+','_','g');
  return coalesce(nullif(base,''),'file') || case when ext='' then '' else '.'||ext end;
end $$;
create or replace function public.photo_create_upload_attempt(p_actor uuid,p_job_id uuid,p_source_signature text,p_digest text,p_original_name text,p_original_bytes bigint,p_mime_type text,p_attempt_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.photo_upload_attempts; root text;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not exists(select 1 from public.jobs where id=p_job_id and is_active) or p_source_signature is null or p_source_signature='' or
    p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_original_name is null or p_original_name='' or p_original_name ~ '[/\\]' or
    p_original_bytes is null or p_original_bytes not between 0 and 9007199254740991 or p_mime_type is null or p_attempt_id is null or p_photo_id is null
  then raise exception 'invalid_input'; end if;
  root:=p_actor::text||'/'||p_photo_id::text;
  insert into public.photo_upload_attempts(id,actor_id,job_id,source_signature,content_sha256,photo_id,original_name,original_bytes,mime_type,original_path,thumb_path,preview_path,sidecar_path)
  values(p_attempt_id,p_actor,p_job_id,p_source_signature,p_digest,p_photo_id,p_original_name,p_original_bytes,p_mime_type,'originals/'||root||'/'||public.photo_storage_filename(p_original_name),
    'derived/'||p_actor::text||'/'||p_photo_id::text||'_thumb.webp','derived/'||p_actor::text||'/'||p_photo_id::text||'_preview.webp','originals/'||root||'/'||regexp_replace(public.photo_storage_filename(p_original_name),'\.[^.]+$','')||'.xmp') on conflict(id) do nothing;
  select * into a from public.photo_upload_attempts where id=p_attempt_id for update;
  if (a.actor_id,a.job_id,a.source_signature,a.content_sha256,a.photo_id,a.original_name,a.original_bytes,a.mime_type)
    is distinct from (p_actor,p_job_id,p_source_signature,p_digest,p_photo_id,p_original_name,p_original_bytes,p_mime_type) then raise exception 'conflict'; end if;
  return to_jsonb(a);
end $$;
create or replace function public.photo_acquire_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; generation bigint; expiry timestamptz:=clock_timestamp()+interval '2 minutes';
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if v->'result' is not null and v->'result'<>'null'::jsonb then return v->'result'; end if;
  if (v->>'lease_expires_at')::timestamptz>clock_timestamp() then raise exception 'lease_busy'; end if;
  generation:=(v->>'lease_generation')::bigint+1;
  if p_owner_kind='ordinary' then
    update public.photo_upload_attempts set lease_generation=generation,lease_expires_at=expiry,status='uploading',updated_at=clock_timestamp() where id=p_owner_id;
  else
    update public.migration_items set lease_generation=generation,lease_expires_at=expiry,status='uploading',updated_at=clock_timestamp() where id=p_owner_id;
  end if;
  return jsonb_build_object('status','acquired','lease_generation',generation,'lease_expires_at',expiry);
end $$;
create or replace function public.photo_canonical_outcome(p_digest text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare outcome jsonb;
begin
  perform public.photo_require_gate('writes');
  select jsonb_build_object('status',case when deleted_at is null then 'duplicate_active' else 'duplicate_trashed' end,
    'photo_id',id,'job_id',job_id,'purge_after',purge_after)
  into outcome from public.photos where content_sha256=p_digest order by created_at,id limit 1;
  return outcome;
end $$;
create or replace function public.photo_claim_content(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; c public.photo_content_claims; outcome jsonb; digest text; expiry timestamptz:=clock_timestamp()+interval '2 minutes';
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id); digest:=v->>'content_sha256';
  if p_generation is null or (v->>'lease_generation')::bigint<>p_generation or coalesce((v->>'lease_expires_at')::timestamptz<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
  if digest is null then raise exception 'invalid_input'; end if;
  -- Serialize absent-row claim creation and finalization on the same digest.
  perform pg_advisory_xact_lock(hashtextextended(digest,0));
  outcome:=public.photo_canonical_outcome(digest); if outcome is not null then return outcome; end if;
  select * into c from public.photo_content_claims where content_sha256=digest for update;
  if found and c.lease_expires_at>clock_timestamp() then
    if c.actor_id=p_actor and c.owner_generation=p_generation and
      ((p_owner_kind='ordinary' and c.upload_attempt_id=p_owner_id) or (p_owner_kind='migration' and c.migration_item_id=p_owner_id))
    then return jsonb_build_object('status','claimed','claim_generation',c.lease_generation,'lease_expires_at',c.lease_expires_at); end if;
    return jsonb_build_object('status','waiting_claim','lease_expires_at',c.lease_expires_at);
  end if;
  insert into public.photo_content_claims(content_sha256,migration_item_id,upload_attempt_id,actor_id,lease_generation,lease_expires_at,owner_generation)
  values(digest,case when p_owner_kind='migration' then p_owner_id end,case when p_owner_kind='ordinary' then p_owner_id end,p_actor,coalesce(c.lease_generation,0)+1,expiry,p_generation)
  on conflict(content_sha256) do update set migration_item_id=excluded.migration_item_id,upload_attempt_id=excluded.upload_attempt_id,actor_id=excluded.actor_id,
    lease_generation=excluded.lease_generation,lease_expires_at=excluded.lease_expires_at,owner_generation=excluded.owner_generation
  returning * into c;
  return jsonb_build_object('status','claimed','claim_generation',c.lease_generation,'lease_expires_at',c.lease_expires_at);
end $$;
create or replace function public.photo_renew_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint,p_claim_generation bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; expiry timestamptz:=clock_timestamp()+interval '2 minutes';
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if p_generation is null or (v->>'lease_generation')::bigint<>p_generation or coalesce((v->>'lease_expires_at')::timestamptz<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
  update public.photo_content_claims set lease_expires_at=expiry where content_sha256=v->>'content_sha256' and actor_id=p_actor and lease_generation=p_claim_generation and owner_generation=p_generation
    and lease_expires_at>clock_timestamp() and ((p_owner_kind='ordinary' and upload_attempt_id=p_owner_id) or (p_owner_kind='migration' and migration_item_id=p_owner_id));
  if not found then raise exception 'stale_claim'; end if;
  if p_owner_kind='ordinary' then update public.photo_upload_attempts set lease_expires_at=expiry,updated_at=clock_timestamp() where id=p_owner_id;
  else update public.migration_items set lease_expires_at=expiry,updated_at=clock_timestamp() where id=p_owner_id; end if;
  return jsonb_build_object('lease_expires_at',expiry);
end $$;
create or replace function public.photo_finalize_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint,p_claim_generation bigint,p_photo jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; c public.photo_content_claims; outcome jsonb; digest text; existing public.photos; original_size bigint; path text; job uuid; photo uuid; field text; v_warnings jsonb;
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id); digest:=v->>'content_sha256'; job:=(v->>'job_id')::uuid; photo:=(v->>'photo_id')::uuid;
  -- Exact committed-payload replay is allowed after lease release, but never
  -- lets an unrelated actor, source revision or attempt borrow a photo UUID.
  if v->'result' is not null and v->'result'<>'null'::jsonb then
    if v->'finalize_payload' is distinct from p_photo then raise exception 'conflict'; end if;
    return v->'result';
  end if;
  if p_generation is null or (v->>'lease_generation')::bigint<>p_generation or coalesce((v->>'lease_expires_at')::timestamptz<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
  if digest is null or digest !~ '^[0-9a-f]{64}$' or not exists(select 1 from public.jobs where id=job and is_active) then raise exception 'invalid_input'; end if;
  path:=v->>'original_path';
  if path is null or path is distinct from ('originals/'||p_actor::text||'/'||photo::text||'/'||public.photo_storage_filename(v->>'original_name')) or path ~ '(^|/)\.\.(/|$)' then raise exception 'invalid_input'; end if;
  if p_photo is null or jsonb_typeof(p_photo)<>'object' or p_photo->>'kind' is null or p_photo->>'kind' not in ('image','video','file') then raise exception 'invalid_input'; end if;
  -- Sidecar and derivative destinations must be bound to this attempt.
  foreach field in array array['thumb_path','preview_path','sidecar_path'] loop
    if p_photo->>field is not null then
      if p_photo->>field is distinct from v->>field or p_photo->>field ~ '(^|/)\.\.(/|$)' then raise exception 'invalid_input'; end if;
      if field='sidecar_path' then
        if p_photo->>field not like 'originals/'||p_actor::text||'/'||photo::text||'/%' then raise exception 'invalid_input'; end if;
      elsif p_photo->>field is distinct from ('derived/'||p_actor::text||'/'||photo::text||(case field when 'thumb_path' then '_thumb.webp' else '_preview.webp' end)) then
        raise exception 'invalid_input';
      end if;
    end if;
  end loop;
  select (metadata->>'size')::bigint into original_size from storage.objects where bucket_id='photos' and name=path;
  if original_size is distinct from (v->>'original_bytes')::bigint then raise exception 'original_unverified'; end if;
  perform pg_advisory_xact_lock(hashtextextended(digest,0));
  select * into c from public.photo_content_claims where content_sha256=digest for update;
  if not found or c.actor_id<>p_actor or c.lease_generation is distinct from p_claim_generation or c.owner_generation<>p_generation or c.lease_expires_at<=clock_timestamp()
    or not coalesce(((p_owner_kind='ordinary' and c.upload_attempt_id=p_owner_id) or (p_owner_kind='migration' and c.migration_item_id=p_owner_id)),false)
  then raise exception 'stale_claim'; end if;
  select * into existing from public.photos where id=photo;
  if found then raise exception 'conflict'; end if;
  outcome:=public.photo_canonical_outcome(digest); v_warnings:=coalesce(p_photo->'warnings','[]');
  if outcome is null then
    begin
      insert into public.photos(id,job_id,uploader_id,kind,sheet_number,tags,captured_at,captured_at_source,original_path,original_bytes,mime_type,original_name,
        thumb_path,preview_path,sidecar_path,sidecar_name,duration_secs,content_sha256,upload_attempt_id,migration_item_id,upload_warnings)
      values(photo,job,p_actor,p_photo->>'kind',p_photo->>'sheet_number',coalesce(array(select jsonb_array_elements_text(p_photo->'tags')),'{}'),
        coalesce((p_photo->>'captured_at')::timestamptz,clock_timestamp()),coalesce(p_photo->>'captured_at_source','upload'),path,original_size,v->>'mime_type',v->>'original_name',
        p_photo->>'thumb_path',p_photo->>'preview_path',p_photo->>'sidecar_path',p_photo->>'sidecar_name',(p_photo->>'duration_secs')::numeric,digest,
        case when p_owner_kind='ordinary' then p_owner_id else (v->>'upload_attempt_id')::uuid end,case when p_owner_kind='migration' then p_owner_id end,v_warnings);
      outcome:=jsonb_build_object('status','created','photo_id',photo,'job_id',job);
    exception when unique_violation then
      outcome:=public.photo_canonical_outcome(digest); if outcome is null then raise exception 'conflict'; end if;
    end;
  end if;
  if p_owner_kind='ordinary' then
    update public.photo_upload_attempts set status=case when outcome->>'status'='created' then 'completed' else outcome->>'status' end,
      result=outcome,finalize_payload=p_photo,warnings=v_warnings,lease_expires_at=null,updated_at=clock_timestamp() where id=p_owner_id;
  else
    update public.migration_items set status=case when outcome->>'status'='created' then 'completed'
      when outcome->>'status'='duplicate_trashed' then 'restore_required' when (outcome->>'job_id')::uuid<>job then 'job_conflict' else 'skipped_duplicate' end,
      result=outcome,finalize_payload=p_photo,warnings=v_warnings,canonical_photo_id=(outcome->>'photo_id')::uuid,canonical_job_id=(outcome->>'job_id')::uuid,
      lease_expires_at=null,updated_at=clock_timestamp() where id=p_owner_id;
  end if;
  delete from public.photo_content_claims where content_sha256=digest and lease_generation=p_claim_generation;
  return outcome;
end $$;
create or replace function public.photo_cancel_migration(p_actor uuid,p_batch_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare batch_status text;
begin
  select status into batch_status from public.migration_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'migration');
  if batch_status='completed' then raise exception 'conflict'; end if;
  update public.migration_batches set status='cancelled',updated_at=clock_timestamp() where id=p_batch_id;
  update public.migration_items set status='cancelled',lease_generation=lease_generation+1,lease_expires_at=null,updated_at=clock_timestamp()
    where source_id in(select id from public.migration_sources where batch_id=p_batch_id)
      and status not in ('completed','skipped_duplicate','skipped_missing','skipped_unsupported','skipped_failed','skipped_user','cancelled');
  delete from public.photo_content_claims where migration_item_id in(select i.id from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=p_batch_id);
end $$;

create or replace function public.photo_guard_action_targets()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare state text; batch uuid;
begin
  batch:=case when tg_op='DELETE' then old.batch_id else new.batch_id end;
  select status into state from public.photo_action_batches where id=batch for update;
  if tg_op in ('INSERT','DELETE') and state<>'draft' then raise exception 'conflict'; end if;
  if tg_op='UPDATE' and (new.batch_id,new.photo_id,new.expected_job_id,new.expected_deleted_at) is distinct from
    (old.batch_id,old.photo_id,old.expected_job_id,old.expected_deleted_at) then raise exception 'conflict'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists photo_guard_action_targets on public.photo_action_items;
create trigger photo_guard_action_targets before insert or update or delete on public.photo_action_items for each row execute function public.photo_guard_action_targets();
create or replace function public.photo_guard_batch_contract()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.created_by,new.origin,new.action) is distinct from (old.created_by,old.origin,old.action)
    or (old.status<>'draft' and (new.selector,new.destination_job_id,new.approved_by,new.approved_at) is distinct from (old.selector,old.destination_job_id,old.approved_by,old.approved_at))
  then raise exception 'conflict'; end if;
  if new.status='completed' and exists(select 1 from public.photo_action_items where batch_id=new.id and status not in ('applied','skipped')) then raise exception 'conflict'; end if;
  return new;
end $$;
drop trigger if exists photo_guard_batch_contract on public.photo_action_batches;
create trigger photo_guard_batch_contract before update on public.photo_action_batches for each row execute function public.photo_guard_batch_contract();
create or replace function public.photo_guard_source_mapping()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare state text; batch uuid;
begin
  if tg_op='UPDATE' and new.batch_id is distinct from old.batch_id then raise exception 'conflict'; end if;
  batch:=case when tg_op='DELETE' then old.batch_id else new.batch_id end;
  select status into state from public.migration_batches where id=batch for update;
  if tg_op in ('INSERT','DELETE') and state<>'draft' then raise exception 'conflict'; end if;
  if tg_op='UPDATE' and state<>'draft' and (new.batch_id,new.job_id,new.kind,new.selection_rules) is distinct from (old.batch_id,old.job_id,old.kind,old.selection_rules) then raise exception 'conflict'; end if;
  if tg_op<>'DELETE' and not exists(select 1 from public.jobs where id=new.job_id and is_active) then raise exception 'invalid_input'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists photo_guard_source_mapping on public.migration_sources;
create trigger photo_guard_source_mapping before insert or update or delete on public.migration_sources for each row execute function public.photo_guard_source_mapping();
create or replace function public.photo_guard_migration_contract()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.created_by,new.origin,new.script_name) is distinct from (old.created_by,old.origin,old.script_name)
    or (old.status<>'draft' and (new.approved_by,new.approved_at,new.approved_rules) is distinct from (old.approved_by,old.approved_at,old.approved_rules))
    or (old.status in ('completed','cancelled') and new.status<>old.status)
  then raise exception 'conflict'; end if;
  if old.status='draft' and new.status='approved' then
    if new.approved_by is distinct from new.created_by or new.approved_at is null or new.approved_rules is null
      or not exists(select 1 from public.migration_sources where batch_id=new.id)
      or exists(select 1 from public.migration_sources where batch_id=new.id and (sealed_at is null or scan_id is distinct from sealed_scan_id))
    then raise exception 'conflict'; end if;
  end if;
  if new.status='completed' and exists(select 1 from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=new.id and i.is_current
    and i.status not in ('completed','skipped_duplicate','skipped_missing','skipped_unsupported','skipped_failed','skipped_user')) then raise exception 'conflict'; end if;
  return new;
end $$;
drop trigger if exists photo_guard_migration_contract on public.migration_batches;
create trigger photo_guard_migration_contract before update on public.migration_batches for each row execute function public.photo_guard_migration_contract();
create or replace function public.photo_guard_upload_identity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_table_name='photo_upload_attempts' then
    if (new.id,new.actor_id,new.job_id,new.source_signature,new.content_sha256,new.photo_id,new.original_name,new.original_bytes,new.mime_type,new.original_path,new.thumb_path,new.preview_path,new.sidecar_path)
      is distinct from (old.id,old.actor_id,old.job_id,old.source_signature,old.content_sha256,old.photo_id,old.original_name,old.original_bytes,old.mime_type,old.original_path,old.thumb_path,old.preview_path,old.sidecar_path)
    then raise exception 'conflict'; end if;
    if old.result is not null and (new.result,new.finalize_payload) is distinct from (old.result,old.finalize_payload) then raise exception 'conflict'; end if;
  else
    if (new.id,new.source_id,new.relative_path,new.revision,new.source_signature,new.source_mtime,new.original_name,new.original_bytes,new.mime_type,new.photo_id,new.upload_attempt_id)
      is distinct from (old.id,old.source_id,old.relative_path,old.revision,old.source_signature,old.source_mtime,old.original_name,old.original_bytes,old.mime_type,old.photo_id,old.upload_attempt_id)
      or (old.content_sha256 is not null and new.content_sha256 is distinct from old.content_sha256)
      or (old.original_path is not null and new.original_path is distinct from old.original_path)
    then raise exception 'conflict'; end if;
    if old.status in ('completed','skipped_duplicate') and (new.status,new.result,new.finalize_payload) is distinct from (old.status,old.result,old.finalize_payload) then raise exception 'conflict'; end if;
  end if;
  return new;
end $$;
drop trigger if exists photo_guard_upload_identity on public.photo_upload_attempts;
create trigger photo_guard_upload_identity before update on public.photo_upload_attempts for each row execute function public.photo_guard_upload_identity();
drop trigger if exists photo_guard_upload_identity on public.migration_items;
create trigger photo_guard_upload_identity before update on public.migration_items for each row execute function public.photo_guard_upload_identity();
create or replace function public.photo_approve_action(p_actor uuid,p_batch_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches;
begin
  select * into b from public.photo_action_batches where id=p_batch_id for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch_id,'action',b.action);
  if b.status<>'draft' then raise exception 'conflict'; end if;
  if b.destination_job_id is not null and not exists(select 1 from public.jobs where id=b.destination_job_id and is_active) then raise exception 'invalid_input'; end if;
  if not exists(select 1 from public.photo_action_items where batch_id=p_batch_id) then raise exception 'invalid_input'; end if;
  -- UI confirmation grants broad move only. Trash/restore retain row ownership.
  if b.origin='ui' and b.action<>'move' and not exists(select 1 from public.user_profiles where user_id=p_actor and role='admin') and exists(
    select 1 from public.photo_action_items i join public.photos p on p.id=i.photo_id where i.batch_id=p_batch_id and p.uploader_id<>p_actor)
  then raise exception 'forbidden'; end if;
  update public.photo_action_batches set status='approved',approved_at=clock_timestamp(),approved_by=p_actor,updated_at=clock_timestamp() where id=p_batch_id;
end $$;
create or replace function public.photo_apply_action(p_actor uuid,p_batch_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.photo_action_batches; i public.photo_action_items; p public.photos; v_result jsonb; instant timestamptz;
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
  if b.origin='ui' and b.action<>'move' and p.uploader_id<>p_actor and not exists(select 1 from public.user_profiles where user_id=p_actor and role='admin') then raise exception 'forbidden'; end if;
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
    elsif b.action='restore' and p.deleted_at is not null then
      if p.purge_after<=instant or p.purge_claimed_at is not null then raise exception 'conflict'; end if;
      -- Legacy duplicates never become independently active. The later resolver
      -- materializes the canonical target into its own exact confirmation.
      if p.duplicate_of is not null then return jsonb_build_object('status','canonical_required','photo_id',p.duplicate_of); end if;
      update public.photos set deleted_at=null,deleted_by=null,purge_after=null,job_id=coalesce(b.destination_job_id,p.job_id) where id=p_photo_id;
    end if;
  end if;
  v_result:=jsonb_build_object('status','applied','photo_id',p_photo_id,'action',b.action);
  update public.photo_action_items set status='applied',actor_id=p_actor,result=v_result,lease_generation=lease_generation+1,lease_expires_at=null,updated_at=instant where batch_id=p_batch_id and photo_id=p_photo_id;
  return v_result;
end $$;

-- Installed only at cutover; expansion preserves the old write behavior.
-- current_setting('role') retains the PostgREST/SET ROLE caller inside this
-- SECURITY DEFINER trigger, while current_user would name the function owner.
create or replace function public.photo_guard_direct_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if current_setting('role',true) in ('authenticated','anon') then
    perform public.photo_require_gate('writes');
    perform public.photo_require_actor(auth.uid());
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;

-- This is an operator action, never an expansion hook. It is intentionally
-- callable with all gates closed. No canonical mapping/index change happens here.
create or replace function public.photo_install_write_boundary(p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare col text; pol record;
begin
  perform public.photo_require_actor(p_actor);
  if not exists(select 1 from public.user_profiles where user_id=p_actor and role='admin') then raise exception 'forbidden'; end if;
  perform 1 from public.photo_release_state where singleton and not photo_writes_enabled and not mcp_enabled and not repair_enabled for update;
  if not found then raise exception 'photo_gate_closed'; end if;
  revoke all on public.photos from public,anon,authenticated;
  -- Column ACLs survive table-level REVOKE; clear those inherited old grants too.
  for col in select attname from pg_attribute where attrelid='public.photos'::regclass and attnum>0 and not attisdropped loop
    execute format('revoke all (%I) on public.photos from public,anon,authenticated',col);
  end loop;
  grant select on public.photos to authenticated;
  grant update(sheet_number,tags) on public.photos to authenticated;
  for pol in select policyname from pg_policies where schemaname='public' and tablename='photos' and cmd in ('INSERT','DELETE','UPDATE','ALL') loop
    execute format('drop policy %I on public.photos',pol.policyname);
  end loop;
  create policy photos_update on public.photos for update to authenticated using(deleted_at is null) with check(deleted_at is null);
  drop trigger if exists photo_guard_direct_write on public.photos;
  create trigger photo_guard_direct_write before insert or update or delete on public.photos for each row execute function public.photo_guard_direct_write();
  update public.photo_release_state set write_boundary_installed_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by=p_actor where singleton;
end $$;

-- Apply explicit ACLs even on reapplication: baseline defaults grant execution
-- to clients, including trigger and private helper functions.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'photo\_%' escape '\' or p.proname='consume_dws_handoff') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
commit;
