-- Shared upload outcomes, fenced release, and post-commit cleanup authority.
-- Global content index activation remains an operator-only cutover.
begin;
alter table public.photo_upload_attempts drop constraint if exists photo_upload_attempts_status_check;
alter table public.photo_upload_attempts add constraint photo_upload_attempts_status_check check(status in
 ('pending','waiting_claim','uploading','finalizing','completed','duplicate_active','duplicate_trashed',
  'skipped_duplicate','job_conflict','restore_required','cancelled','retryable_failed'));


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
    if batch_status not in ('approved','running') and not coalesce((v->'result'<>'null'::jsonb),false) then raise exception 'conflict'; end if;
  else raise exception 'invalid_input'; end if;
  if v->>'status'='cancelled' and coalesce(v->'result','null'::jsonb)='null'::jsonb then raise exception 'conflict'; end if;
  return v;
end $$;

create or replace function public.photo_canonical_outcome(p_digest text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare outcomes jsonb;
begin
  perform public.photo_require_gate('writes');
  select jsonb_agg(jsonb_build_object('status',case when deleted_at is null then 'duplicate_active' else 'duplicate_trashed' end,
    'photo_id',id,'job_id',job_id,'purge_after',purge_after))
    into outcomes from public.photos where content_sha256=p_digest;
  if jsonb_array_length(outcomes)>1 then raise exception 'conflict'; end if;
  return outcomes->0;
end $$;

-- Both preflight and late-finalize outcomes close the owner's lease. Only
-- claims belonging to this exact owner/generation may be released.
create or replace function public.photo_record_upload_outcome(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint,p_job uuid,p_outcome jsonb,p_payload jsonb default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare state text:=case when p_outcome->>'status'='created' then 'completed'
  when p_outcome->>'status'='duplicate_trashed' then 'restore_required'
  when (p_outcome->>'job_id')::uuid<>p_job then 'job_conflict' else 'skipped_duplicate' end;
begin
  if p_owner_kind='ordinary' then
    update public.photo_upload_attempts set status=state,result=p_outcome,finalize_payload=p_payload,
      warnings=coalesce(p_payload->'warnings','[]'),error=null,lease_expires_at=null,updated_at=clock_timestamp() where id=p_owner_id;
  else
    update public.migration_items set status=state,result=p_outcome,finalize_payload=p_payload,
      warnings=coalesce(p_payload->'warnings','[]'),error=null,canonical_photo_id=(p_outcome->>'photo_id')::uuid,
      canonical_job_id=(p_outcome->>'job_id')::uuid,lease_expires_at=null,updated_at=clock_timestamp() where id=p_owner_id;
  end if;
  delete from public.photo_content_claims where actor_id=p_actor and owner_generation=p_generation and
    ((p_owner_kind='ordinary' and upload_attempt_id=p_owner_id) or (p_owner_kind='migration' and migration_item_id=p_owner_id));
end $$;

create or replace function public.photo_refresh_upload_outcome(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; outcome jsonb; state text;
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if v->>'status' not in ('job_conflict','restore_required') or coalesce(v->'result','null'::jsonb)='null'::jsonb then return v->'result'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v->>'content_sha256',0));
  outcome:=public.photo_canonical_outcome(v->>'content_sha256');
  -- A purged canonical never reactivates paths already eligible for cleanup.
  if outcome is null then return (v->'result')||jsonb_build_object('new_attempt_required',true); end if;
  state:=case when outcome->>'status'='duplicate_trashed' then 'restore_required'
    when outcome->>'job_id'<>v->>'job_id' then 'job_conflict' else 'skipped_duplicate' end;
  if p_owner_kind='ordinary' then update public.photo_upload_attempts set status=state,result=outcome,updated_at=clock_timestamp() where id=p_owner_id;
  else update public.migration_items set status=state,result=outcome,canonical_photo_id=(outcome->>'photo_id')::uuid,
    canonical_job_id=(outcome->>'job_id')::uuid,updated_at=clock_timestamp() where id=p_owner_id; end if;
  return outcome;
end $$;

create or replace function public.photo_create_upload_attempt(p_actor uuid,p_job_id uuid,p_source_signature text,p_digest text,p_original_name text,p_original_bytes bigint,p_mime_type text,p_attempt_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.photo_upload_attempts; root text; refreshed jsonb;
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
  if a.status in ('job_conflict','restore_required') then
    refreshed:=public.photo_refresh_upload_outcome(p_actor,'ordinary',p_attempt_id);
    select * into a from public.photo_upload_attempts where id=p_attempt_id;
    return to_jsonb(a)||jsonb_build_object('result',refreshed);
  end if;
  return to_jsonb(a);
end $$;

create or replace function public.photo_acquire_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; generation bigint; expiry timestamptz:=clock_timestamp()+interval '2 minutes';
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if v->'result' is not null and v->'result'<>'null'::jsonb then return public.photo_refresh_upload_outcome(p_actor,p_owner_kind,p_owner_id); end if;
  if (v->>'lease_expires_at')::timestamptz>clock_timestamp() then raise exception 'lease_busy'; end if;
  generation:=(v->>'lease_generation')::bigint+1;
  if p_owner_kind='ordinary' then
    update public.photo_upload_attempts set lease_generation=generation,lease_expires_at=expiry,status='uploading',updated_at=clock_timestamp() where id=p_owner_id;
  else
    update public.migration_items set lease_generation=generation,lease_expires_at=expiry,status='uploading',updated_at=clock_timestamp() where id=p_owner_id;
  end if;
  return jsonb_build_object('status','acquired','lease_generation',generation,'lease_expires_at',expiry);
end $$;

create or replace function public.photo_claim_content(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; c public.photo_content_claims; outcome jsonb; digest text; expiry timestamptz:=clock_timestamp()+interval '2 minutes';
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id); digest:=v->>'content_sha256';
  if coalesce(v->'result','null'::jsonb)<>'null'::jsonb then return public.photo_refresh_upload_outcome(p_actor,p_owner_kind,p_owner_id); end if;
  if p_generation is null or (v->>'lease_generation')::bigint<>p_generation or coalesce((v->>'lease_expires_at')::timestamptz<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
  if digest is null then raise exception 'invalid_input'; end if;
  -- Serialize absent-row claim creation and finalization on the same digest.
  perform pg_advisory_xact_lock(hashtextextended(digest,0));
  outcome:=public.photo_canonical_outcome(digest);
  if outcome is not null then
    perform public.photo_record_upload_outcome(p_actor,p_owner_kind,p_owner_id,p_generation,(v->>'job_id')::uuid,outcome);
    return outcome;
  end if;
  select * into c from public.photo_content_claims where content_sha256=digest for update;
  if found and c.lease_expires_at>clock_timestamp() then
    if c.actor_id=p_actor and c.owner_generation=p_generation and
      ((p_owner_kind='ordinary' and c.upload_attempt_id=p_owner_id) or (p_owner_kind='migration' and c.migration_item_id=p_owner_id))
    then return jsonb_build_object('status','claimed','claim_generation',c.lease_generation,'lease_expires_at',c.lease_expires_at); end if;
    if p_owner_kind='ordinary' then update public.photo_upload_attempts set status='waiting_claim',updated_at=clock_timestamp() where id=p_owner_id;
    else update public.migration_items set status='waiting_claim',updated_at=clock_timestamp() where id=p_owner_id; end if;
    return jsonb_build_object('status','waiting_claim','lease_expires_at',c.lease_expires_at);
  end if;
  insert into public.photo_content_claims(content_sha256,migration_item_id,upload_attempt_id,actor_id,lease_generation,lease_expires_at,owner_generation)
  values(digest,case when p_owner_kind='migration' then p_owner_id end,case when p_owner_kind='ordinary' then p_owner_id end,p_actor,coalesce(c.lease_generation,0)+1,expiry,p_generation)
  on conflict(content_sha256) do update set migration_item_id=excluded.migration_item_id,upload_attempt_id=excluded.upload_attempt_id,actor_id=excluded.actor_id,
    lease_generation=excluded.lease_generation,lease_expires_at=excluded.lease_expires_at,owner_generation=excluded.owner_generation
  returning * into c;
  if p_owner_kind='ordinary' then update public.photo_upload_attempts set status='uploading',updated_at=clock_timestamp() where id=p_owner_id;
  else update public.migration_items set status='uploading',updated_at=clock_timestamp() where id=p_owner_id; end if;
  return jsonb_build_object('status','claimed','claim_generation',c.lease_generation,'lease_expires_at',c.lease_expires_at);
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
  perform public.photo_record_upload_outcome(p_actor,p_owner_kind,p_owner_id,p_generation,job,outcome,p_photo);
  return outcome;
end $$;

create or replace function public.photo_guard_upload_identity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_table_name='photo_upload_attempts' then
    if (new.id,new.actor_id,new.job_id,new.source_signature,new.content_sha256,new.photo_id,new.original_name,new.original_bytes,new.mime_type,new.original_path,new.thumb_path,new.preview_path,new.sidecar_path)
      is distinct from (old.id,old.actor_id,old.job_id,old.source_signature,old.content_sha256,old.photo_id,old.original_name,old.original_bytes,old.mime_type,old.original_path,old.thumb_path,old.preview_path,old.sidecar_path)
    then raise exception 'conflict'; end if;
  else
    if (new.id,new.source_id,new.relative_path,new.revision,new.source_signature,new.source_mtime,new.original_name,new.original_bytes,new.mime_type,new.photo_id,new.upload_attempt_id)
      is distinct from (old.id,old.source_id,old.relative_path,old.revision,old.source_signature,old.source_mtime,old.original_name,old.original_bytes,old.mime_type,old.photo_id,old.upload_attempt_id)
      or (old.content_sha256 is not null and new.content_sha256 is distinct from old.content_sha256)
      or (old.original_path is not null and new.original_path is distinct from old.original_path)
    then raise exception 'conflict'; end if;
    if old.status in ('completed','skipped_duplicate') and (new.status,new.result,new.finalize_payload) is distinct from (old.status,old.result,old.finalize_payload) then raise exception 'conflict'; end if;
  end if;
  -- A committed result reserves its UUID permanently. Cleanup can safely run
  -- after the transaction because no worker can reactivate those paths.
  if old.result is not null and (new.result,new.finalize_payload) is distinct from (old.result,old.finalize_payload) and not (
      old.status in ('job_conflict','restore_required') and new.status in ('job_conflict','restore_required','skipped_duplicate')
      and new.finalize_payload is not distinct from old.finalize_payload
      and new.result is not distinct from public.photo_canonical_outcome(old.content_sha256)) then raise exception 'conflict'; end if;
  if old.result is not null and (new.status in ('pending','hashing','waiting_claim','uploading','finalizing','retryable_failed') or new.lease_expires_at is not null) then raise exception 'conflict'; end if;
  return new;
end $$;

create or replace function public.photo_release_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint,p_status text,p_error_code text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; state text;
begin
  if p_status is null or p_status not in ('retryable_failed','cancelled') or length(p_error_code)>100 then raise exception 'invalid_input'; end if;
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if coalesce(v->'result','null'::jsonb)<>'null'::jsonb then return v->'result'; end if;
  if p_generation is null or (v->>'lease_generation')::bigint<>p_generation or
    coalesce((v->>'lease_expires_at')::timestamptz<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
  state:=case when v->>'status'='waiting_claim' and p_status='retryable_failed' then 'waiting_claim' else p_status end;
  perform pg_advisory_xact_lock(hashtextextended(v->>'content_sha256',0));
  if p_owner_kind='ordinary' then
    update public.photo_upload_attempts set status=state,lease_expires_at=null,
      error=case when p_error_code is not null then jsonb_build_object('code',p_error_code) end,updated_at=clock_timestamp() where id=p_owner_id;
  else
    update public.migration_items set status=state,lease_expires_at=null,
      error=case when p_error_code is not null then jsonb_build_object('code',p_error_code) end,updated_at=clock_timestamp() where id=p_owner_id;
  end if;
  delete from public.photo_content_claims where actor_id=p_actor and owner_generation=p_generation and
    ((p_owner_kind='ordinary' and upload_attempt_id=p_owner_id) or (p_owner_kind='migration' and migration_item_id=p_owner_id));
  return jsonb_build_object('status',state);
end $$;

-- A UUID belongs to one durable owner across both ledgers. Combined with
-- deterministic finalize paths and immutable results this prevents a new upload
-- from claiming a cleanup candidate between the DB check and Storage DELETE.
create or replace function public.photo_reserve_upload_uuid()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-upload:'||new.photo_id::text,0));
  if tg_table_name='photo_upload_attempts' then
    if exists(select 1 from public.migration_items where photo_id=new.photo_id) then raise exception 'conflict'; end if;
    if not exists(select 1 from public.photo_upload_attempts where id=new.id and photo_id=new.photo_id)
      and exists(select 1 from public.photos where id=new.photo_id) then raise exception 'conflict'; end if;
  else
    if exists(select 1 from public.photo_upload_attempts where photo_id=new.photo_id) then raise exception 'conflict'; end if;
    if not exists(select 1 from public.migration_items where id=new.id and photo_id=new.photo_id)
      and exists(select 1 from public.photos where id=new.photo_id) then raise exception 'conflict'; end if;
  end if;
  return new;
end $$;
drop trigger if exists photo_reserve_upload_uuid on public.photo_upload_attempts;
create trigger photo_reserve_upload_uuid before insert on public.photo_upload_attempts for each row execute function public.photo_reserve_upload_uuid();
drop trigger if exists photo_reserve_upload_uuid on public.migration_items;
create trigger photo_reserve_upload_uuid before insert on public.migration_items for each row execute function public.photo_reserve_upload_uuid();

create or replace function public.photo_upload_cleanup_paths(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns text[] language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; root text; original text; candidates text[]; safe_paths text[];
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if coalesce(v->'result'->>'status','') not in ('duplicate_active','duplicate_trashed') then return '{}'; end if;
  if (v->>'lease_expires_at')::timestamptz>clock_timestamp() then return '{}'; end if;
  root:=p_actor::text||'/'||(v->>'photo_id'); original:=public.photo_storage_filename(v->>'original_name');
  candidates:=array['originals/'||root||'/'||original,
    'derived/'||root||'_thumb.webp','derived/'||root||'_preview.webp',
    'originals/'||root||'/'||regexp_replace(original,'\.[^.]+$','')||'.xmp'];
  select coalesce(array_agg(distinct path order by path),'{}') into safe_paths from unnest(candidates) as candidate(path)
  where not exists(select 1 from public.photos p where path=any(array[p.original_path,p.thumb_path,p.preview_path,p.sidecar_path,p.playback_path]))
    and not exists(select 1 from public.photo_upload_attempts a
      where not (p_owner_kind='ordinary' and a.id=p_owner_id)
        and (a.lease_expires_at>clock_timestamp() or (a.result is null and a.status<>'cancelled'))
        and path=any(array[a.original_path,a.thumb_path,a.preview_path,a.sidecar_path]))
    and not exists(select 1 from public.migration_items i
      where not (p_owner_kind='migration' and i.id=p_owner_id)
        and (i.lease_expires_at>clock_timestamp() or (i.result is null and i.status not in ('cancelled','skipped_missing','skipped_unsupported','skipped_failed','skipped_user')))
        and path=any(array[i.original_path,i.thumb_path,i.preview_path,i.sidecar_path]));
  return safe_paths;
end $$;

create or replace function public.photo_attach_upload_sidecar(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_sidecar_name text,p_sidecar_bytes bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; photo public.photos; path text; bytes bigint; retained jsonb;
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if v->'result'->>'status' is distinct from 'created' or p_sidecar_name is null or p_sidecar_name='' or p_sidecar_name ~ '[/\\]'
    or p_sidecar_bytes is null or p_sidecar_bytes not between 0 and 9007199254740991 then raise exception 'conflict'; end if;
  select * into photo from public.photos where id=(v->>'photo_id')::uuid for update;
  if not found or photo.deleted_at is not null or photo.uploader_id<>p_actor or photo.job_id is distinct from (v->>'job_id')::uuid
    or photo.original_path is distinct from v->>'original_path' or photo.original_bytes is distinct from (v->>'original_bytes')::bigint or photo.content_sha256 is distinct from v->>'content_sha256'
    or (p_owner_kind='ordinary' and photo.upload_attempt_id is distinct from p_owner_id)
    or (p_owner_kind='migration' and photo.migration_item_id is distinct from p_owner_id) then raise exception 'conflict'; end if;
  path:='originals/'||p_actor::text||'/'||(v->>'photo_id')||'/'||regexp_replace(public.photo_storage_filename(v->>'original_name'),'\.[^.]+$','')||'.xmp';
  if path=photo.original_path or path is distinct from v->>'sidecar_path' or (photo.sidecar_path is not null and (photo.sidecar_path is distinct from path or photo.sidecar_name is distinct from p_sidecar_name)) then raise exception 'conflict'; end if;
  select (metadata->>'size')::bigint into bytes from storage.objects where bucket_id='photos' and name=path;
  if bytes is distinct from p_sidecar_bytes then raise exception 'sidecar_unverified'; end if;
  select coalesce(jsonb_agg(warning),'[]') into retained from jsonb_array_elements(coalesce(v->'warnings','[]')) as warnings(warning)
    where warning#>>'{}' not in ('sidecar_missing','sidecar_failed') and warning#>>'{}' not like 'Sidecar upload failed.%'
      and warning#>>'{}' not like 'Sidecar % was not reselected;%';
  update public.photos set sidecar_path=path,sidecar_name=p_sidecar_name,upload_warnings=retained where id=photo.id;
  if p_owner_kind='ordinary' then update public.photo_upload_attempts set warnings=retained,updated_at=clock_timestamp() where id=p_owner_id;
  else update public.migration_items set warnings=retained,updated_at=clock_timestamp() where id=p_owner_id; end if;
  return (v->'result')||jsonb_build_object('warnings',retained);
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'photo\_%' escape '\' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
-- Only the validated claim/finalize transactions call the mutation helper.
revoke all on function public.photo_record_upload_outcome(uuid,text,uuid,bigint,uuid,jsonb,jsonb) from service_role;
commit;
