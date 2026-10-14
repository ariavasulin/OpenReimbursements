-- Importing a folder makes an album only when asked (the owner's round-three notes).
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching review screen. Two
-- functions are re-created from 20260921035400_photo_import_albums.sql, each
-- changing only the lines named below. Safe for the live app: an import sealed by
-- the old screen after this is applied shows every folder with "Make an album" off,
-- which the new screen lets the person turn on; the old screen's blank-name rule
-- (blank restores the folder's name) is unchanged.
--
-- The model stays the one the upload functions already read: a folder row with
-- album_name set makes (or joins) an album; a row with album_name null makes none
-- (migration_upload_albums returns no album for it, and approval then requires a
-- project). What changes is the default and what null means on the review screen.
--
-- migration_seal. CHANGED: one line. A folder row is created with album_name null
--   (no album) instead of the name from its path. The name is derived again when the
--   person turns "Make an album" on (migration_folder_update with album_name '').
-- migration_folder_update. CHANGED: the album_name block. An explicit JSON null now
--   means "no album" for a folder too (it already did for loose files); '' or blanks
--   still mean "the name from the folder's path" for a folder.
-- UNCHANGED: everything else, including the approve check (a row with photos needs a
--   project or an album), migration_upload_albums, and the guard trigger.
begin;

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
  -- Approval freezes the reviewed folder set as well as its choices. An approved
  -- rescan may refresh files in those folders, but new folders need a new draft.
  -- Refuse before reconciliation so no new item or folder can bypass review.
  if b.status<>'draft' and exists (
    with scanned_folders as materialized (
      select distinct public.migration_folder_of(entry.value->>'relative_path') as folder
      from public.migration_inventory_chunks c cross join lateral jsonb_array_elements(c.entries) as entry(value)
      where c.source_id=p_source and c.scan_id=p_scan
        and coalesce(entry.value->>'status','pending') not in ('skipped_unsupported','skipped_missing')
    )
    select 1 from scanned_folders scanned where not exists (
      select 1 from public.migration_folders f where f.source_id=p_source and f.folder=scanned.folder
    )
  ) then raise exception 'new_folders_require_review'; end if;
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
  -- Folder rows, derived from the inventory just sealed. Written so that no step can turn
  -- into rows-times-rows whatever the planner believes (the lesson of Step 5 above): zero
  -- this source's counts, then one pass over its items, grouped, upserted. ON CONFLICT finds
  -- an existing row through the unique index by construction; there is no join to reorder.
  update public.migration_folders set photo_count=0,updated_at=clock_timestamp() where source_id=p_source and photo_count<>0;
  insert into public.migration_folders(source_id,folder,album_name,job_id,tags,photo_count,created_scan_id)
    select p_source,c.folder,null::text,
      s.job_id,public.migration_default_tags(s.selection_rules),c.photos,p_scan
    from (select public.migration_folder_of(i.relative_path) as folder,count(*)::integer as photos from public.migration_items i
      where i.source_id=p_source and i.is_current and i.status not in ('skipped_unsupported','skipped_missing') group by 1) c
  on conflict(source_id,folder) do update set photo_count=excluded.photo_count,updated_at=clock_timestamp();
  update public.migration_sources set sealed_scan_id=p_scan,sealed_fingerprint=fingerprint,sealed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_source returning * into s;
  return s;
end $$;

create or replace function public.migration_folder_update(p_actor uuid,p_source uuid,p_folder text,p_subfolders boolean,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.migration_sources; b public.migration_batches; next_tags text[]; next_name text; n_updated integer;
  deep boolean:=coalesce(p_subfolders,false);
begin
  select * into s from public.migration_sources where id=p_source;
  if not found then raise exception 'not_found'; end if;
  b:=public.migration_lock_batch(p_actor,s.batch_id);
  if b.status<>'draft' then raise exception 'conflict'; end if;
  if p_folder is null or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb
    or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('job_id','tags','album_name','album_id'))
    or (deep and (p_patch ? 'album_name' or p_patch ? 'album_id'))
    or (p_patch ? 'album_name' and p_patch ? 'album_id')
    or (p_patch ? 'album_id' and s.kind<>'files')
    or (p_patch ? 'job_id' and jsonb_typeof(p_patch->'job_id') not in ('string','null'))
    or (p_patch ? 'album_id' and jsonb_typeof(p_patch->'album_id') not in ('string','null'))
    or (p_patch ? 'album_name' and jsonb_typeof(p_patch->'album_name') not in ('string','null'))
    or (p_patch ? 'tags' and jsonb_typeof(p_patch->'tags')<>'array')
  then raise exception 'invalid_input'; end if;
  if p_patch->>'job_id' is not null and not exists(select 1 from public.jobs where id=(p_patch->>'job_id')::uuid and is_active) then raise exception 'invalid_input'; end if;
  if p_patch->>'album_id' is not null and not exists(select 1 from public.albums where id=(p_patch->>'album_id')::uuid and deleted_at is null) then raise exception 'invalid_input'; end if;
  if p_patch ? 'tags' then
    next_tags:=public.photo_clean_tags(array(select jsonb_array_elements_text(p_patch->'tags')));
    select coalesce(array_agg(coalesce((
        select t.tag from public.photos lib cross join lateral unnest(lib.tags) t(tag)
        where lib.deleted_at is null and lower(t.tag)=lower(a.tag) group by t.tag order by count(*) desc,t.tag collate "C" limit 1),a.tag) order by a.ord),'{}')
      into next_tags from unnest(next_tags) with ordinality a(tag,ord);
  end if;
  if p_patch ? 'album_name' then
    -- null: no album. '' (or blanks): the name from the folder's path, for a folder; none for loose files.
    if jsonb_typeof(p_patch->'album_name')='null' then next_name:=null;
    else
      next_name:=nullif(btrim(p_patch->>'album_name'),'');
      if next_name is not null then next_name:=public.photo_job_name(next_name);
      elsif s.kind='directory' then next_name:=public.migration_album_name(s.label,p_folder); end if;
    end if;
  end if;
  update public.migration_folders f set
      job_id=case when p_patch ? 'job_id' then (p_patch->>'job_id')::uuid else f.job_id end,
      tags=case when p_patch ? 'tags' then next_tags else f.tags end,
      album_name=case when p_patch ? 'album_name' then next_name when p_patch->>'album_id' is not null then null else f.album_name end,
      album_id=case when p_patch ? 'album_id' then (p_patch->>'album_id')::uuid when p_patch ? 'album_name' then null else f.album_id end,
      updated_at=clock_timestamp()
    where f.source_id=p_source and (f.folder=p_folder or (deep and (p_folder='' or left(f.folder,char_length(p_folder)+1)=p_folder||'/')));
  get diagnostics n_updated=row_count;
  if n_updated=0 then raise exception 'not_found'; end if;
  return jsonb_build_object('updated',n_updated);
end $$;

-- Grants, by name (`create or replace` keeps the ACL; restated for a rebuilt database).
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('migration_seal','migration_folder_update') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
