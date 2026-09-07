-- Foreground migration ledger. Chunk payloads are staged until a contiguous scan seals.
begin;
alter table public.migration_inventory_chunks add column if not exists entries jsonb not null default '[]';
alter table public.migration_items add column if not exists retry_after timestamptz;
alter table public.migration_items add column if not exists retryable boolean;
alter table public.migration_items add column if not exists new_attempt_required boolean not null default false;
alter table public.migration_items add column if not exists retry_count integer not null default 0;

create or replace function public.photo_guard_migration_contract()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.created_by,new.origin,new.script_name) is distinct from (old.created_by,old.origin,old.script_name)
    or (old.status<>'draft' and (new.approved_by,new.approved_at,new.approved_rules) is distinct from (old.approved_by,old.approved_at,old.approved_rules))
    or (old.status='cancelled' and new.status<>old.status)
    or (old.status='completed' and new.status not in ('completed','interrupted'))
  then raise exception 'conflict'; end if;
  if new.status in ('approved','running','completed') and
    (not exists(select 1 from public.migration_sources where batch_id=new.id) or
      exists(select 1 from public.migration_sources where batch_id=new.id and (sealed_at is null or scan_id is distinct from sealed_scan_id)))
  then raise exception 'conflict'; end if;
  if old.status='draft' and new.status='approved' and
    (new.approved_by is distinct from new.created_by or new.approved_at is null or new.approved_rules is null)
  then raise exception 'conflict'; end if;
  if new.status='completed' and exists(select 1 from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=new.id and i.is_current
    and i.status not in ('completed','skipped_duplicate','skipped_missing','skipped_unsupported','skipped_failed','skipped_user')) then raise exception 'conflict'; end if;
  return new;
end $$;

create or replace function public.migration_lock_batch(p_actor uuid,p_batch uuid)
returns public.migration_batches language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches;
begin
  select * into b from public.migration_batches where id=p_batch for update;
  perform public.photo_assert_batch_actor(p_actor,p_batch,'migration');
  return b;
end $$;
create or replace function public.migration_create_batch(p_actor uuid,p_script text)
returns public.migration_batches language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_script is null or p_script not in ('migrate_photos','add_photos') then raise exception 'invalid_input'; end if;
  insert into public.migration_batches(created_by,origin,script_name) values(p_actor,'ui',p_script) returning * into b;
  return b;
end $$;
create or replace function public.migration_source(p_actor uuid,p_batch uuid,p_source uuid,p_job uuid,p_kind text,p_label text,p_rules jsonb)
returns public.migration_sources language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches; s public.migration_sources;
begin
  b:=public.migration_lock_batch(p_actor,p_batch);
  if b.status<>'draft' then raise exception 'conflict'; end if;
  if not exists(select 1 from public.jobs where id=p_job and is_active) or p_kind not in ('directory','files') or p_label is null or length(p_label) not between 1 and 512 then raise exception 'invalid_input'; end if;
  if b.script_name='add_photos' and (p_kind<>'files' or exists(select 1 from public.migration_sources where batch_id=p_batch and id<>p_source)) then raise exception 'conflict'; end if;
  select * into s from public.migration_sources where id=p_source;
  if found and s.batch_id<>p_batch then raise exception 'conflict'; end if;
  insert into public.migration_sources(id,batch_id,job_id,kind,label,selection_rules) values(p_source,p_batch,p_job,p_kind,p_label,p_rules)
  on conflict(id) do update set job_id=excluded.job_id,kind=excluded.kind,label=excluded.label,selection_rules=excluded.selection_rules,scan_id=case when (migration_sources.job_id,migration_sources.kind,migration_sources.selection_rules) is distinct from (excluded.job_id,excluded.kind,excluded.selection_rules) then null else migration_sources.scan_id end,updated_at=clock_timestamp() returning * into s;
  return s;
end $$;
create or replace function public.migration_scan(p_actor uuid,p_source uuid,p_scan uuid)
returns public.migration_sources language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches; s public.migration_sources;
begin
  select * into s from public.migration_sources where id=p_source;
  if not found then raise exception 'not_found'; end if;
  b:=public.migration_lock_batch(p_actor,s.batch_id);
  select * into s from public.migration_sources where id=p_source for update;
  if b.status='cancelled' then raise exception 'conflict'; end if;
  if s.scan_id=p_scan then return s; end if;
  if exists(select 1 from public.migration_inventory_chunks where source_id=p_source and scan_id=p_scan) or p_scan is null then raise exception 'conflict'; end if;
  if exists(select 1 from public.migration_items i join public.migration_sources x on x.id=i.source_id where x.batch_id=b.id and i.lease_expires_at>clock_timestamp()) then raise exception 'lease_busy'; end if;
  -- The batch lock fences finalize before changing any revision or scan.
  if b.status<>'draft' then
    update public.migration_batches set status='interrupted',updated_at=clock_timestamp() where id=b.id;
    update public.migration_items set lease_generation=lease_generation+1,lease_expires_at=null where source_id in(select id from public.migration_sources where batch_id=b.id) and result is null;
    delete from public.photo_content_claims where migration_item_id in(select i.id from public.migration_items i join public.migration_sources x on x.id=i.source_id where x.batch_id=b.id);
  end if;
  update public.migration_sources set scan_id=p_scan,updated_at=clock_timestamp() where id=p_source returning * into s;
  return s;
end $$;
create or replace function public.migration_chunk(p_actor uuid,p_source uuid,p_scan uuid,p_number integer,p_digest text,p_encoded integer,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.migration_sources; b public.migration_batches; c public.migration_inventory_chunks; total bigint;
begin
  select * into s from public.migration_sources where id=p_source;
  if not found then raise exception 'not_found'; end if;
  b:=public.migration_lock_batch(p_actor,s.batch_id);
  select * into s from public.migration_sources where id=p_source for update;
  if b.status='cancelled' or s.scan_id is distinct from p_scan then raise exception 'conflict'; end if;
  if p_number is null or p_number<0 or jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)>500 or p_encoded not between 0 and 1048576 then raise exception 'invalid_input'; end if;
  select * into c from public.migration_inventory_chunks where source_id=p_source and scan_id=p_scan and chunk_number=p_number;
  if found then
    if c.payload_digest<>p_digest or c.entries<>p_entries then raise exception 'conflict'; end if;
    return jsonb_build_object('replayed',true,'entry_count',c.entry_count,'total_bytes',c.total_bytes,'payload_digest',c.payload_digest);
  end if;
  if s.sealed_scan_id=p_scan then raise exception 'conflict'; end if;
  select coalesce(sum((e->>'original_bytes')::bigint),0) into total from jsonb_array_elements(p_entries) e;
  insert into public.migration_inventory_chunks(source_id,scan_id,chunk_number,payload_digest,entry_count,encoded_bytes,total_bytes,entries)
    values(p_source,p_scan,p_number,p_digest,jsonb_array_length(p_entries),p_encoded,total,p_entries);
  return jsonb_build_object('replayed',false,'entry_count',jsonb_array_length(p_entries),'total_bytes',total,'payload_digest',p_digest);
end $$;
create or replace function public.migration_seal(p_actor uuid,p_source uuid,p_scan uuid,p_chunks integer,p_entries bigint,p_bytes bigint,p_job uuid,p_fingerprint text)
returns public.migration_sources language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.migration_sources; b public.migration_batches; n integer; highest integer; fingerprint text; entries_total bigint; bytes_total bigint;
begin
  select * into s from public.migration_sources where id=p_source;
  if not found then raise exception 'not_found'; end if;
  b:=public.migration_lock_batch(p_actor,s.batch_id);
  select * into s from public.migration_sources where id=p_source for update;
  if b.status='cancelled' or s.scan_id is distinct from p_scan then raise exception 'conflict'; end if;
  select count(*),max(chunk_number),sum(entry_count),sum(total_bytes),encode(extensions.digest(coalesce(string_agg(payload_digest,'' order by chunk_number),''),'sha256'),'hex') into n,highest,entries_total,bytes_total,fingerprint
    from public.migration_inventory_chunks where source_id=p_source and scan_id=p_scan;
  if p_chunks is null or p_chunks<0 or n<>p_chunks or (n>0 and highest<>n-1) then raise exception 'conflict'; end if;
  if p_entries is distinct from coalesce(entries_total,0) or p_bytes is distinct from coalesce(bytes_total,0) or p_job is distinct from s.job_id or p_fingerprint is distinct from fingerprint then raise exception 'conflict'; end if;
  if s.sealed_scan_id=p_scan then return s; end if;
  if exists(select 1 from public.migration_inventory_chunks c cross join lateral jsonb_array_elements(c.entries) as entry(value)
    where c.source_id=p_source and c.scan_id=p_scan group by entry.value->>'relative_path' having count(*)>1) then raise exception 'conflict'; end if;
  -- Set-based reconciliation keeps a large scan within one atomic commit without
  -- a separate query round trip for each file. Retire precedes insert, preserving
  -- the partial unique current-path constraint and immutable historical IDs.
  with staged as materialized (
    select entry.value e from public.migration_inventory_chunks c
      cross join lateral jsonb_array_elements(c.entries) as entry(value)
      where c.source_id=p_source and c.scan_id=p_scan
  ), matched as materialized (
    select staged.e,i.id old_id,i.revision old_revision,
      i.id is not null and i.status<>'skipped_missing' and
      (i.source_signature,i.original_bytes,i.source_mtime,i.mime_type,i.original_name) is not distinct from
      (e->>'source_signature',(e->>'original_bytes')::bigint,(e->>'source_mtime')::bigint,e->>'mime_type',e->>'original_name') same
    from staged left join public.migration_items i on i.source_id=p_source and i.relative_path=staged.e->>'relative_path' and i.is_current
  ), retired as (
    update public.migration_items i set is_current=false,lease_expires_at=null,lease_generation=lease_generation+1
      from matched m where i.id=m.old_id and not m.same returning i.id
  ), inserted as (
    insert into public.migration_items(source_id,relative_path,revision,scan_id,source_signature,source_mtime,original_name,original_bytes,mime_type,sidecar,status,warnings)
      select p_source,e->>'relative_path',coalesce(old_revision,0)+1,p_scan,e->>'source_signature',(e->>'source_mtime')::bigint,e->>'original_name',(e->>'original_bytes')::bigint,e->>'mime_type',nullif(e->'sidecar','null'::jsonb),coalesce(e->>'status','pending'),coalesce(e->'warnings','[]')
      from matched where not same and (select count(*) from retired)>=0 returning id
  )
  update public.migration_items i set scan_id=p_scan,sidecar=nullif(m.e->'sidecar','null'::jsonb),updated_at=clock_timestamp()
    from matched m where i.id=m.old_id and m.same and (select count(*) from inserted)>=0;
  -- Completed outcomes remain historical/current when absent; unfinished missing files are explicit skips.
  update public.migration_items set status='skipped_missing',lease_expires_at=null,lease_generation=lease_generation+1,updated_at=clock_timestamp()
    where source_id=p_source and is_current and scan_id<>p_scan and status not in ('completed','skipped_duplicate');
  update public.migration_sources set sealed_scan_id=p_scan,sealed_fingerprint=fingerprint,sealed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_source returning * into s;
  return s;
end $$;

create or replace function public.migration_batch_action(p_actor uuid,p_batch uuid,p_action text)
returns public.migration_batches language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches; rules jsonb;
begin
  b:=public.migration_lock_batch(p_actor,p_batch);
  if p_action='cancel' then perform public.photo_cancel_migration(p_actor,p_batch);
  elsif p_action='approve' then
    if b.status<>'draft' then raise exception 'conflict'; end if;
    select jsonb_agg(jsonb_build_object('source_id',id,'job_id',job_id,'kind',kind,'selection_rules',selection_rules) order by id) into rules from public.migration_sources where batch_id=p_batch;
    update public.migration_batches set status='approved',approved_by=p_actor,approved_at=clock_timestamp(),approved_rules=rules,updated_at=clock_timestamp() where id=p_batch;
  elsif p_action='resume' then
    if b.status not in ('approved','running','interrupted') or b.approved_at is null then raise exception 'conflict'; end if;
    update public.migration_batches set status='running',updated_at=clock_timestamp() where id=p_batch;
  elsif p_action='pause' then
    if b.status not in ('approved','running','interrupted') then raise exception 'conflict'; end if;
    update public.migration_batches set status='interrupted',updated_at=clock_timestamp() where id=p_batch;
    update public.migration_items set lease_generation=lease_generation+1,lease_expires_at=null where source_id in(select id from public.migration_sources where batch_id=p_batch) and result is null;
    delete from public.photo_content_claims where migration_item_id in(select i.id from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=p_batch);
  elsif p_action='complete' then
    if b.status not in ('approved','running','interrupted','completed') or b.approved_at is null then raise exception 'conflict'; end if;
    update public.migration_batches set status='completed',updated_at=clock_timestamp() where id=p_batch;
  else raise exception 'invalid_input'; end if;
  select * into b from public.migration_batches where id=p_batch; return b;
end $$;

create or replace function public.migration_item_action(p_actor uuid,p_item uuid,p_action text,p_fresh boolean default false)
returns public.migration_items language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.migration_items; b public.migration_batches; batch uuid;
begin
  select s.batch_id into batch from public.migration_items x join public.migration_sources s on s.id=x.source_id where x.id=p_item;
  b:=public.migration_lock_batch(p_actor,batch);
  select * into i from public.migration_items where id=p_item for update;
  if not i.is_current or b.status in ('draft','cancelled','completed') or i.status in ('completed','skipped_duplicate') then raise exception 'conflict'; end if;
  if i.lease_expires_at>clock_timestamp() then raise exception 'lease_busy'; end if;
  if p_action='skip' then
    update public.migration_items set status='skipped_user',lease_expires_at=null,lease_generation=lease_generation+1,updated_at=clock_timestamp() where id=p_item returning * into i;
  elsif p_action='retry' then
    if p_fresh or i.new_attempt_required or i.result is not null or i.status='cancelled' then
      update public.migration_items set is_current=false,lease_expires_at=null,lease_generation=lease_generation+1 where id=i.id;
      insert into public.migration_items(source_id,relative_path,revision,scan_id,source_signature,source_mtime,original_name,original_bytes,mime_type,sidecar)
        values(i.source_id,i.relative_path,i.revision+1,i.scan_id,i.source_signature,i.source_mtime,i.original_name,i.original_bytes,i.mime_type,i.sidecar) returning * into i;
    else
      update public.migration_items set status='pending',retry_after=null,retryable=null,new_attempt_required=false,error=null,lease_generation=lease_generation+1,updated_at=clock_timestamp() where id=p_item returning * into i;
    end if;
  else raise exception 'invalid_input'; end if;
  delete from public.photo_content_claims where migration_item_id=p_item;
  return i;
end $$;
create or replace function public.migration_prepare(p_actor uuid,p_item uuid,p_revision integer,p_signature text,p_digest text,p_attempt uuid default null,p_photo uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; root text; refreshed jsonb;
begin
  v:=public.photo_lock_upload(p_actor,'migration',p_item);
  if (v->>'revision')::integer is distinct from p_revision or v->>'source_signature' is distinct from p_signature or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then raise exception 'conflict'; end if;
  if v->>'status' in ('skipped_missing','skipped_unsupported','skipped_failed','skipped_user') then raise exception 'conflict'; end if;
  if (p_attempt is not null and p_attempt is distinct from (v->>'upload_attempt_id')::uuid) or (p_photo is not null and p_photo is distinct from (v->>'photo_id')::uuid) then raise exception 'conflict'; end if;
  if v->>'content_sha256' is not null and v->>'content_sha256'<>p_digest then raise exception 'source_changed'; end if;
  root:=p_actor::text||'/'||(v->>'photo_id');
  update public.migration_items set content_sha256=p_digest,
    original_path='originals/'||root||'/'||public.photo_storage_filename(v->>'original_name'),
    thumb_path='derived/'||root||'_thumb.webp',preview_path='derived/'||root||'_preview.webp',
    sidecar_path='originals/'||root||'/'||regexp_replace(public.photo_storage_filename(v->>'original_name'),'\.[^.]+$','')||'.xmp',updated_at=clock_timestamp() where id=p_item;
  refreshed:=public.photo_refresh_upload_outcome(p_actor,'migration',p_item);
  return public.photo_lock_upload(p_actor,'migration',p_item)||jsonb_build_object('result',refreshed);
end $$;

create or replace function public.migration_counts(p_actor uuid,p_batch uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare counts jsonb; total bigint; bytes numeric; xmp bigint; warning_count bigint; exclusions jsonb; sidecar_bytes numeric;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if not exists(select 1 from public.migration_batches where id=p_batch) then raise exception 'not_found'; end if;
  select coalesce(jsonb_object_agg(status,n),'{}') into counts from (select i.status,count(*) n from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=p_batch and i.is_current group by i.status) q;
  select count(*),coalesce(sum(i.original_bytes),0),count(*) filter(where i.sidecar is not null and i.sidecar<>'null'::jsonb),coalesce(sum(jsonb_array_length(i.warnings)),0),coalesce(sum((i.sidecar->>'original_bytes')::bigint),0) into total,bytes,xmp,warning_count,sidecar_bytes from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=p_batch and i.is_current;
  select coalesce(jsonb_object_agg(reason,n),'{}') into exclusions from (select coalesce(i.warnings->>0,'unsupported') reason,count(*) n from public.migration_items i join public.migration_sources s on s.id=i.source_id where s.batch_id=p_batch and i.is_current and i.status='skipped_unsupported' group by 1) q;
  return jsonb_build_object('total',total,'total_bytes',bytes,'media_bytes',bytes,'sidecar_bytes',sidecar_bytes,'upload_bytes',bytes+sidecar_bytes,'by_status',counts,'xmp',xmp,'warnings',warning_count,'exclusions_by_reason',exclusions);
end $$;
create or replace function public.migration_item_outcome(p_actor uuid,p_item uuid,p_retry timestamptz,p_code text,p_warnings jsonb,p_generation bigint,p_retryable boolean,p_fresh boolean)
returns public.migration_items language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.migration_items; b public.migration_batches; batch uuid;
begin
  select s.batch_id into batch from public.migration_items x join public.migration_sources s on s.id=x.source_id where x.id=p_item;
  b:=public.migration_lock_batch(p_actor,batch);
  select * into i from public.migration_items where id=p_item for update;
  if not i.is_current or b.status not in ('running','approved','interrupted') or i.result is not null or i.lease_expires_at>clock_timestamp() or i.lease_generation is distinct from p_generation or i.status not in ('pending','hashing','uploading','finalizing','retryable_failed','waiting_claim') then raise exception 'conflict'; end if;
  update public.migration_items set status='retryable_failed',retryable=p_retryable,new_attempt_required=p_fresh,retry_after=p_retry,retry_count=retry_count+1,error=jsonb_build_object('code',p_code),warnings=p_warnings,updated_at=clock_timestamp() where id=p_item returning * into i;
  return i;
end $$;
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
    if not (v->>'is_current')::boolean or v->>'status' in ('skipped_missing','skipped_unsupported','skipped_failed','skipped_user') then raise exception 'conflict'; end if;
    if (v->>'retryable')::boolean=false or (v->>'retry_after')::timestamptz>clock_timestamp() then raise exception 'conflict'; end if;
    if batch_status not in ('approved','running') and not coalesce((v->'result'<>'null'::jsonb),false) then raise exception 'conflict'; end if;
  else raise exception 'invalid_input'; end if;
  if v->>'status'='cancelled' and coalesce(v->'result','null'::jsonb)='null'::jsonb then raise exception 'conflict'; end if;
  return v;
end $$;

-- One reservation lock per transaction bounds memory for a 100,000-item scan.
-- Both owner tables take the same lock before their cross-table UUID checks.
create or replace function public.photo_reserve_upload_uuid()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-upload-identity-reservation',0));
  if exists(select 1 from public.migration_items where photo_id=new.photo_id) then raise exception 'conflict'; end if;
  if not exists(select 1 from public.photo_upload_attempts where id=new.id and photo_id=new.photo_id)
    and exists(select 1 from public.photos where id=new.photo_id) then raise exception 'conflict'; end if;
  return new;
end $$;
-- A transition table validates the whole migration insert in two indexed joins;
-- per-row reservation would still issue hundreds of thousands of tiny queries.
create or replace function public.migration_reserve_uuid_lock()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-upload-identity-reservation',0));
  return null;
end $$;
drop trigger if exists photo_reserve_upload_uuid_lock on public.migration_items;
create trigger photo_reserve_upload_uuid_lock before insert on public.migration_items
  for each statement execute function public.migration_reserve_uuid_lock();
create or replace function public.migration_reserve_uuids()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from reserved_items n join public.photo_upload_attempts a on a.photo_id=n.photo_id)
    or exists(select 1 from reserved_items n join public.photos p on p.id=n.photo_id)
  then raise exception 'conflict'; end if;
  return null;
end $$;
drop trigger if exists photo_reserve_upload_uuid on public.migration_items;
create trigger photo_reserve_upload_uuid after insert on public.migration_items
  referencing new table as reserved_items for each statement execute function public.migration_reserve_uuids();
-- Function creation inherits baseline default EXECUTE grants; close every new boundary.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'migration_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
