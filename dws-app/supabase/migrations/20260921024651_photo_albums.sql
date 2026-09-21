-- Optional project, albums, and bulk tagging
-- (plans/active/photo-albums/plan.md, Phase 3; Decisions 1-5, 7, 8).
--
-- WHEN TO APPLY: BEFORE the merge, with the other additive migrations and
-- BEFORE the column-drop file (20260920235021), which runs only after the
-- deploy. On a fresh database the files replay in name order instead, so this
-- file is written to be correct in either order: it never names the dropped
-- column, and that file's closing check would reject any function that did.
--
-- WHY IT IS SAFE FOR THE APP THAT IS LIVE TODAY:
--   * Every schema change only loosens or adds. A project that may be empty, two
--     new tables, one new column with a default. No existing row changes.
--   * The live app calls these functions by named parameter. Every existing
--     parameter keeps its name and position. The one new parameter
--     (photo_create_upload_attempt.p_album_ids) has a default, so a call that
--     omits it behaves exactly as before: a project is required and no album is
--     touched.
--   * The live app always names a project and never names an album, so until
--     the deploy no photo without a project and no album row can exist.
--   * The table check that made every move name a destination is dropped. The
--     live route still refuses a move with no destination, and the MCP move
--     script requires one, so nothing can create such a move before the deploy.
--
-- WHAT CHANGES, function by function, is listed above each one. Each re-created
-- function starts from its latest definition and changes only the named lines.
-- No new function checks a role: any signed-in employee may do all of this
-- (Decision 7). Grants are restated by name at the end, never with a blanket
-- photo_% loop, which would hand photo_record_upload_outcome to service_role.
begin;

-- Decision 1: a photo has zero or one project.
alter table public.photos alter column job_id drop not null;

-- Decision 2: albums are a flat many-to-many collection. Names need not be unique.
-- deleted_by points at Auth, as photos.deleted_by does, so albums keep a single
-- foreign key to user_profiles and an unqualified embed stays unambiguous.
create table if not exists public.albums (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references public.user_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  check ((deleted_at is null)=(deleted_by is null))
);
-- Both foreign keys cascade: a purged photo leaves its albums. Trashing a photo
-- keeps the row, so restoring the photo puts it back in its albums.
create table if not exists public.album_photos (
  album_id uuid not null references public.albums(id) on delete cascade,
  photo_id uuid not null references public.photos(id) on delete cascade,
  added_by uuid not null references public.user_profiles(user_id),
  added_at timestamptz not null default now(),
  primary key (album_id, photo_id)
);
create index if not exists album_photos_photo on public.album_photos(photo_id, album_id);

-- Baseline default privileges grant ALL to clients. Strip them, then allow reads only.
alter table public.albums enable row level security;
alter table public.album_photos enable row level security;
revoke all on table public.albums from public,anon,authenticated;
revoke all on table public.album_photos from public,anon,authenticated;
grant select on table public.albums to authenticated;
grant select on table public.album_photos to authenticated;
grant all on table public.albums to service_role;
grant all on table public.album_photos to service_role;
drop policy if exists albums_select on public.albums;
create policy albums_select on public.albums for select to authenticated using (deleted_at is null);
-- A membership row is visible only while its photo is active, so a count taken
-- through the employee's own session can never include a trashed photo.
drop policy if exists album_photos_select on public.album_photos;
create policy album_photos_select on public.album_photos for select to authenticated
  using (exists(select 1 from public.photos p where p.id=album_photos.photo_id and p.deleted_at is null));

-- Upload ledger: a null project plus the albums the upload names.
alter table public.photo_upload_attempts alter column job_id drop not null;
alter table public.photo_upload_attempts add column if not exists album_ids uuid[] not null default '{}';

-- Actions: a photo being acted on may have no project, and a move may name none.
alter table public.photo_action_items alter column expected_job_id drop not null;
-- The check was declared without a name, so find it by what it says. It is the
-- only check on this table that mentions destination_job_id.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.photo_action_batches'::regclass and contype='c'
    and pg_get_constraintdef(oid) ilike '%destination_job_id is not null%' loop
    execute format('alter table public.photo_action_batches drop constraint %I',c.conname);
  end loop;
end $$;

-- Decision 4, the same-photo rule, in one place. NEW. Returns what
-- photo_canonical_outcome returns, after acting on an ACTIVE existing photo:
--   * it joins every album the upload named (repeat-safe);
--   * an empty project is filled with the upload's project; a project that is
--     already set is never changed, so a different one still reads job_conflict.
-- A trashed photo is left alone and stays restore_required; the rule runs again
-- when the outcome is refreshed after the restore.
-- A deleted album still receives the photo: the upload named it while it was
-- live, and restoring the album should show the whole upload.
-- Callers hold the digest advisory lock. Lock order stays owner, digest, photo.
-- Internal: like photo_record_upload_outcome, service_role may not call it.
create or replace function public.photo_same_photo_outcome(p_actor uuid,p_digest text,p_job uuid,p_album_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare outcome jsonb; target uuid;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  outcome:=public.photo_canonical_outcome(p_digest);
  if outcome is null or outcome->>'status'<>'duplicate_active' then return outcome; end if;
  select id into target from public.photos where id=(outcome->>'photo_id')::uuid and deleted_at is null for update;
  -- Trashed while this call waited for the row: report what is true now.
  if not found then return public.photo_canonical_outcome(p_digest); end if;
  insert into public.album_photos(album_id,photo_id,added_by)
    select al.id,target,p_actor from public.albums al where al.id=any(coalesce(p_album_ids,'{}')) on conflict do nothing;
  update public.photos set job_id=p_job where id=target and job_id is null and p_job is not null
    and exists(select 1 from public.jobs where id=p_job and is_active);
  return public.photo_canonical_outcome(p_digest);
end $$;

-- photo_create_upload_attempt, from 20260907100200_hosted_photo_uploads.sql.
-- A new parameter changes the signature, so the old one is dropped here, in the
-- same transaction, rather than left beside the new one: two candidates would
-- make the live app's nine-argument call ambiguous.
-- CHANGED: p_job_id may be null; new p_album_ids (default none), stored sorted
--   and without repeats; refuses invalid_input when both are empty or when any
--   album is missing or deleted; the album list joins the replay comparison, so
--   reusing an attempt with different albums is a conflict, as it is for a
--   different project.
-- UNCHANGED: every other validation, the stored paths, and the replay refresh.
drop function if exists public.photo_create_upload_attempt(uuid,uuid,text,text,text,bigint,text,uuid,uuid);
create or replace function public.photo_create_upload_attempt(p_actor uuid,p_job_id uuid,p_source_signature text,p_digest text,p_original_name text,p_original_bytes bigint,p_mime_type text,p_attempt_id uuid,p_photo_id uuid,p_album_ids uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.photo_upload_attempts; root text; refreshed jsonb; albums uuid[];
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select coalesce(array_agg(distinct x order by x),'{}') into albums from unnest(coalesce(p_album_ids,'{}')) x;
  if (p_job_id is null and cardinality(albums)=0) or (p_job_id is not null and not exists(select 1 from public.jobs where id=p_job_id and is_active)) or
    exists(select 1 from unnest(albums) x where not exists(select 1 from public.albums al where al.id=x and al.deleted_at is null)) or
    p_source_signature is null or p_source_signature='' or
    p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_original_name is null or p_original_name='' or p_original_name ~ '[/\\]' or
    p_original_bytes is null or p_original_bytes not between 0 and 9007199254740991 or p_mime_type is null or p_attempt_id is null or p_photo_id is null
  then raise exception 'invalid_input'; end if;
  root:=p_actor::text||'/'||p_photo_id::text;
  insert into public.photo_upload_attempts(id,actor_id,job_id,album_ids,source_signature,content_sha256,photo_id,original_name,original_bytes,mime_type,original_path,thumb_path,preview_path,sidecar_path)
  values(p_attempt_id,p_actor,p_job_id,albums,p_source_signature,p_digest,p_photo_id,p_original_name,p_original_bytes,p_mime_type,'originals/'||root||'/'||public.photo_storage_filename(p_original_name),
    'derived/'||p_actor::text||'/'||p_photo_id::text||'_thumb.webp','derived/'||p_actor::text||'/'||p_photo_id::text||'_preview.webp','originals/'||root||'/'||regexp_replace(public.photo_storage_filename(p_original_name),'\.[^.]+$','')||'.xmp') on conflict(id) do nothing;
  select * into a from public.photo_upload_attempts where id=p_attempt_id for update;
  if (a.actor_id,a.job_id,a.album_ids,a.source_signature,a.content_sha256,a.photo_id,a.original_name,a.original_bytes,a.mime_type)
    is distinct from (p_actor,p_job_id,albums,p_source_signature,p_digest,p_photo_id,p_original_name,p_original_bytes,p_mime_type) then raise exception 'conflict'; end if;
  if a.status in ('job_conflict','restore_required') then
    refreshed:=public.photo_refresh_upload_outcome(p_actor,'ordinary',p_attempt_id);
    select * into a from public.photo_upload_attempts where id=p_attempt_id;
    return to_jsonb(a)||jsonb_build_object('result',refreshed);
  end if;
  return to_jsonb(a);
end $$;

-- photo_refresh_upload_outcome, from 20260907100200_hosted_photo_uploads.sql.
-- CHANGED: one call. The outcome now comes from photo_same_photo_outcome, so a
--   photo restored after restore_required still joins the upload's albums and
--   has an empty project filled. Without this the rule would be skipped for
--   every upload that first met a trashed copy.
-- UNCHANGED: everything else. The job_conflict test already treats an empty
--   project on either side as "no conflict", because `<>` against null is not true.
create or replace function public.photo_refresh_upload_outcome(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; outcome jsonb; state text;
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if v->>'status' not in ('job_conflict','restore_required') or coalesce(v->'result','null'::jsonb)='null'::jsonb then return v->'result'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v->>'content_sha256',0));
  outcome:=public.photo_same_photo_outcome(p_actor,v->>'content_sha256',(v->>'job_id')::uuid,array(select jsonb_array_elements_text(v->'album_ids'))::uuid[]);
  -- A purged canonical never reactivates paths already eligible for cleanup.
  if outcome is null then return (v->'result')||jsonb_build_object('new_attempt_required',true); end if;
  state:=case when outcome->>'status'='duplicate_trashed' then 'restore_required'
    when outcome->>'job_id'<>v->>'job_id' then 'job_conflict' else 'skipped_duplicate' end;
  if p_owner_kind='ordinary' then update public.photo_upload_attempts set status=state,result=outcome,updated_at=clock_timestamp() where id=p_owner_id;
  else update public.migration_items set status=state,result=outcome,canonical_photo_id=(outcome->>'photo_id')::uuid,
    canonical_job_id=(outcome->>'job_id')::uuid,updated_at=clock_timestamp() where id=p_owner_id; end if;
  return outcome;
end $$;

-- photo_claim_content, from 20260907100200_hosted_photo_uploads.sql.
-- This is where a repeat upload is normally caught, before any bytes move, so
-- the same-photo rule has to run here and not only at finalize.
-- CHANGED: one call, photo_canonical_outcome -> photo_same_photo_outcome.
-- UNCHANGED: lease and generation checks, the digest lock, claim takeover.
-- A migration item has no album list yet (Phase 6), so its list reads as empty.
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
  outcome:=public.photo_same_photo_outcome(p_actor,digest,(v->>'job_id')::uuid,array(select jsonb_array_elements_text(v->'album_ids'))::uuid[]);
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

-- photo_finalize_upload, from migration 20260920234921 (the file that stopped
-- writing the removed photo field; it holds the latest body). Signature unchanged.
-- CHANGED, four things:
--   1. reads the attempt's album list;
--   2. the project check: a named project must still be active, and an upload
--      naming neither a project nor an album is refused invalid_input;
--   3. both late-duplicate lookups go through photo_same_photo_outcome;
--   4. a newly created photo joins the attempt's albums.
-- UNCHANGED: replay, lease, path binding, size verification, the claim check,
--   and the insert's column list.
create or replace function public.photo_finalize_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid,p_generation bigint,p_claim_generation bigint,p_photo jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; c public.photo_content_claims; outcome jsonb; digest text; existing public.photos; original_size bigint; path text; job uuid; photo uuid; field text; v_warnings jsonb; albums uuid[];
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id); digest:=v->>'content_sha256'; job:=(v->>'job_id')::uuid; photo:=(v->>'photo_id')::uuid;
  albums:=array(select jsonb_array_elements_text(v->'album_ids'))::uuid[];
  -- Exact committed-payload replay is allowed after lease release, but never
  -- lets an unrelated actor, source revision or attempt borrow a photo UUID.
  if v->'result' is not null and v->'result'<>'null'::jsonb then
    if v->'finalize_payload' is distinct from p_photo then raise exception 'conflict'; end if;
    return v->'result';
  end if;
  if p_generation is null or (v->>'lease_generation')::bigint<>p_generation or coalesce((v->>'lease_expires_at')::timestamptz<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
  if digest is null or digest !~ '^[0-9a-f]{64}$' or (job is null and cardinality(albums)=0)
    or (job is not null and not exists(select 1 from public.jobs where id=job and is_active)) then raise exception 'invalid_input'; end if;
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
  outcome:=public.photo_same_photo_outcome(p_actor,digest,job,albums); v_warnings:=coalesce(p_photo->'warnings','[]');
  if outcome is null then
    begin
      insert into public.photos(id,job_id,uploader_id,kind,tags,captured_at,captured_at_source,original_path,original_bytes,mime_type,original_name,
        thumb_path,preview_path,sidecar_path,sidecar_name,duration_secs,content_sha256,upload_attempt_id,migration_item_id,upload_warnings)
      values(photo,job,p_actor,p_photo->>'kind',coalesce(array(select jsonb_array_elements_text(p_photo->'tags')),'{}'),
        coalesce((p_photo->>'captured_at')::timestamptz,clock_timestamp()),coalesce(p_photo->>'captured_at_source','upload'),path,original_size,v->>'mime_type',v->>'original_name',
        p_photo->>'thumb_path',p_photo->>'preview_path',p_photo->>'sidecar_path',p_photo->>'sidecar_name',(p_photo->>'duration_secs')::numeric,digest,
        case when p_owner_kind='ordinary' then p_owner_id else (v->>'upload_attempt_id')::uuid end,case when p_owner_kind='migration' then p_owner_id end,v_warnings);
      insert into public.album_photos(album_id,photo_id,added_by)
        select al.id,photo,p_actor from public.albums al where al.id=any(albums) on conflict do nothing;
      outcome:=jsonb_build_object('status','created','photo_id',photo,'job_id',job);
    exception when unique_violation then
      outcome:=public.photo_same_photo_outcome(p_actor,digest,job,albums); if outcome is null then raise exception 'conflict'; end if;
    end;
  end if;
  perform public.photo_record_upload_outcome(p_actor,p_owner_kind,p_owner_id,p_generation,job,outcome,p_photo);
  return outcome;
end $$;

-- photo_apply_action, from 20260920234821_photo_open_trash_authority.sql.
-- CHANGED: three project comparisons in the "already applied elsewhere" test
--   use `is not distinct from` in place of `=`. With `=`, a photo with no project
--   compares as unknown, the test is skipped, and a photo whose project changed
--   after it was listed would be marked applied instead of conflict.
-- UNCHANGED: every other line. A move already writes whatever destination the
--   batch holds, so an empty destination now means "No project" with no edit.
-- photo_approve_action and photo_materialize_action need no change: approve
-- only checks a destination when there is one, and materialize copies the
-- photo's project, empty or not.
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
      or (b.action='restore' and p.deleted_at is null and i.expected_deleted_at is not null and p.job_id is not distinct from coalesce(b.destination_job_id,i.expected_job_id))) then
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

-- Albums. All NEW. Any signed-in employee may create, rename, delete, and
-- restore any album (Decision 7); deleted_by records who deleted it.
-- photo_job_name is reused for the name rule on purpose: it trims, collapses
-- inner spaces, and requires 1-120 characters, which is the album rule too.
-- Each returns the album row as JSON: id, name, created_by, created_at,
-- updated_at, deleted_at, deleted_by.
create or replace function public.photo_create_album(p_actor uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums; n text := public.photo_job_name(p_name);
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  insert into public.albums(name,created_by) values(n,p_actor) returning * into a;
  return jsonb_build_object('status','created','album',to_jsonb(a));
end $$;

-- A deleted album cannot be renamed; restore it first.
create or replace function public.photo_rename_album(p_actor uuid,p_album uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums; n text := public.photo_job_name(p_name);
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  update public.albums set name=n,updated_at=clock_timestamp() where id=p_album and deleted_at is null returning * into a;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('album',to_jsonb(a));
end $$;

-- Deleting an album never deletes a photo and keeps its membership rows, so a
-- restore brings the album back whole. Repeating a delete changes nothing, and
-- in particular does not restart the 30 days.
create or replace function public.photo_delete_album(p_actor uuid,p_album uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into a from public.albums where id=p_album for update;
  if not found then raise exception 'not_found'; end if;
  if a.deleted_at is null then
    update public.albums set deleted_at=clock_timestamp(),deleted_by=p_actor,updated_at=clock_timestamp() where id=p_album returning * into a;
  end if;
  return jsonb_build_object('album',to_jsonb(a));
end $$;

-- Decision 8: recoverable for 30 days. The row is never purged, so after 30
-- days it still exists but can no longer be restored: conflict, as for a photo
-- past its retention.
create or replace function public.photo_restore_album(p_actor uuid,p_album uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into a from public.albums where id=p_album for update;
  if not found then raise exception 'not_found'; end if;
  if a.deleted_at is not null then
    if a.deleted_at+interval '30 days'<=clock_timestamp() then raise exception 'conflict'; end if;
    update public.albums set deleted_at=null,deleted_by=null,updated_at=clock_timestamp() where id=p_album returning * into a;
  end if;
  return jsonb_build_object('album',to_jsonb(a));
end $$;

-- 1-500 ids, counted as sent. Only active photos are added; an id that is
-- trashed or unknown is counted as missing rather than failing the rest.
-- Repeating the call adds nothing: added + already is always the active count.
create or replace function public.photo_album_add(p_actor uuid,p_album uuid,p_photo_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n_requested integer; n_active integer; n_added integer;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_photo_ids is null or cardinality(p_photo_ids) not between 1 and 500 then raise exception 'invalid_input'; end if;
  -- Hold the album against a concurrent delete for the length of this call.
  perform 1 from public.albums where id=p_album and deleted_at is null for share;
  if not found then raise exception 'not_found'; end if;
  select count(distinct x) into n_requested from unnest(p_photo_ids) x where x is not null;
  select count(*) into n_active from public.photos where id=any(p_photo_ids) and deleted_at is null;
  with added as (
    insert into public.album_photos(album_id,photo_id,added_by)
      select p_album,ph.id,p_actor from public.photos ph where ph.id=any(p_photo_ids) and ph.deleted_at is null
      on conflict do nothing returning 1)
  select count(*) into n_added from added;
  return jsonb_build_object('added',n_added,'already',greatest(n_active-n_added,0),'missing',greatest(n_requested-n_active,0));
end $$;

-- Same limits. Only active photos are removed, so a trashed photo keeps its
-- place and comes back into the album when it is restored.
create or replace function public.photo_album_remove(p_actor uuid,p_album uuid,p_photo_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n_removed integer;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_photo_ids is null or cardinality(p_photo_ids) not between 1 and 500 then raise exception 'invalid_input'; end if;
  perform 1 from public.albums where id=p_album and deleted_at is null for share;
  if not found then raise exception 'not_found'; end if;
  with removed as (
    delete from public.album_photos ap using public.photos ph
      where ap.album_id=p_album and ap.photo_id=any(p_photo_ids) and ph.id=ap.photo_id and ph.deleted_at is null returning 1)
  select count(*) into n_removed from removed;
  return jsonb_build_object('removed',n_removed);
end $$;

-- Tag list rule shared by bulk add and remove. NEW, internal. Each tag is
-- trimmed and must be 1-64 characters; at most 20; repeats that differ only by
-- case keep the first spelling. These match the app's existing tag limits.
create or replace function public.photo_clean_tags(p_tags text[])
returns text[] language plpgsql immutable set search_path=public,pg_temp as $$
declare cleaned text[];
begin
  select coalesce(array_agg(d.tag order by d.ord),'{}') into cleaned from (
    select distinct on (lower(t.tag)) t.tag,t.ord from (
      select btrim(u.raw) as tag,u.ord from unnest(coalesce(p_tags,'{}')) with ordinality u(raw,ord)) t
    order by lower(t.tag),t.ord) d;
  if cardinality(cleaned)>20 or exists(select 1 from unnest(cleaned) x where x is null or char_length(x) not between 1 and 64) then
    raise exception 'invalid_input'; end if;
  return cleaned;
end $$;

-- Decision 5. NEW. 1-500 ids, counted as sent; at least one tag to add or remove.
--   * Adding a tag that matches a stored one ignoring case stores the stored
--     spelling (the most used one, if photos disagree). Only tags on active
--     photos count, which is the list the app already shows.
--   * Removing ignores case. A photo that already holds a tag under another
--     spelling is not given a second one.
--   * A photo the change would push past 20 tags is left entirely unchanged and
--     counted as skipped. updated + skipped is the active photo count; an id
--     that is trashed or unknown is counted as missing.
-- Rows are locked in id order so two bulk calls cannot deadlock each other.
create or replace function public.photo_bulk_tag(p_actor uuid,p_photo_ids uuid[],p_add text[] default '{}',p_remove text[] default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare adds text[]; removes text[]; removes_lower text[]; ph record; next_tags text[];
  n_requested integer; n_updated integer:=0; n_skipped integer:=0;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_photo_ids is null or cardinality(p_photo_ids) not between 1 and 500 then raise exception 'invalid_input'; end if;
  adds:=public.photo_clean_tags(p_add); removes:=public.photo_clean_tags(p_remove);
  select coalesce(array_agg(lower(x)),'{}') into removes_lower from unnest(removes) x;
  if cardinality(adds)+cardinality(removes)=0 or exists(select 1 from unnest(adds) x where lower(x)=any(removes_lower)) then raise exception 'invalid_input'; end if;
  select coalesce(array_agg(coalesce((
      select t.tag from public.photos lib cross join lateral unnest(lib.tags) t(tag)
      where lib.deleted_at is null and lower(t.tag)=lower(a.tag) group by t.tag order by count(*) desc,t.tag collate "C" limit 1),a.tag) order by a.ord),'{}')
    into adds from unnest(adds) with ordinality a(tag,ord);
  select count(distinct x) into n_requested from unnest(p_photo_ids) x where x is not null;
  for ph in select id,tags from public.photos where id=any(p_photo_ids) and deleted_at is null order by id for update loop
    next_tags:=array(select t.tag from unnest(ph.tags) with ordinality t(tag,ord) where lower(t.tag)<>all(removes_lower) order by t.ord);
    next_tags:=next_tags||array(select a.tag from unnest(adds) with ordinality a(tag,ord)
      where lower(a.tag)<>all(array(select lower(x) from unnest(next_tags) x)) order by a.ord);
    if cardinality(next_tags)>20 and cardinality(next_tags)>cardinality(ph.tags) then n_skipped:=n_skipped+1; continue; end if;
    if next_tags is distinct from ph.tags then update public.photos set tags=next_tags where id=ph.id; end if;
    n_updated:=n_updated+1;
  end loop;
  return jsonb_build_object('updated',n_updated,'skipped',n_skipped,'missing',greatest(n_requested-n_updated-n_skipped,0));
end $$;

-- Mirrors get_photo_job_summaries: name, active-photo count, four newest
-- thumbnails. SECURITY INVOKER on purpose, as there: an employee's call also
-- inherits the row rules on albums, album_photos, and photos. The active-only
-- filters stay explicit so a service-role caller gets the same answer.
create or replace function public.get_photo_album_summaries(q text default null)
returns table (
  id           uuid,
  name         text,
  photo_count  bigint,
  latest_added timestamptz,
  thumbs       text[],
  created_at   timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.id,
    a.name,
    coalesce(c.photo_count, 0) as photo_count,
    c.latest_added,
    coalesce(t.thumbs, '{}'::text[]) as thumbs,
    a.created_at
  from public.albums a
  left join lateral (
    select count(*) as photo_count, max(ap.added_at) as latest_added
    from public.album_photos ap
    join public.photos p on p.id = ap.photo_id
    where ap.album_id = a.id and p.deleted_at is null
  ) c on true
  left join lateral (
    select array_agg(x.thumb_path order by x.created_at desc) as thumbs
    from (
      select p2.thumb_path, p2.created_at
      from public.album_photos ap2
      join public.photos p2 on p2.id = ap2.photo_id
      where ap2.album_id = a.id and p2.deleted_at is null and p2.thumb_path is not null
      order by p2.created_at desc
      limit 4
    ) x
  ) t on true
  where a.deleted_at is null
    and (q is null or a.name ilike '%' || q || '%')
  -- Most recently added-to first; an empty album sorts by when it was made.
  order by coalesce(c.latest_added, a.created_at) desc, a.id;
$$;

-- Bounded scalar envelopes bypass PostgREST's table-result max_rows cap. The
-- legacy RPCs stay callable during rollout. Each continuation retains the exact
-- database timestamp (including microseconds), and an id breaks every sort tie.
-- These are live views, not snapshots: concurrent collection activity may move a
-- row ahead of a cursor; a subsequent refresh picks up its new position.
create or replace function public.get_photo_album_summaries_page(
  q text default null, p_limit integer default 200,
  p_after_activity timestamptz default null, p_after_id uuid default null
)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 or
     (p_after_activity is null)<>(p_after_id is null) or
     (p_after_activity is not null and not isfinite(p_after_activity)) then
    raise exception 'invalid_input';
  end if;
  with candidates as (
    select s.*, row_number() over (order by coalesce(s.latest_added,s.created_at) desc,s.id) as position
    from public.get_photo_album_summaries(q) s
    where p_after_id is null or coalesce(s.latest_added,s.created_at)<p_after_activity
      or (coalesce(s.latest_added,s.created_at)=p_after_activity and s.id>p_after_id)
    order by coalesce(s.latest_added,s.created_at) desc,s.id
    limit p_limit+1
  )
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(to_jsonb(c)-'position' order by position) filter(where position<=p_limit),'[]'::jsonb),
    'next_cursor',case when count(*)>p_limit then
      (jsonb_agg(jsonb_build_object('activity',coalesce(c.latest_added,c.created_at),'id',c.id) order by position)
        filter(where position<=p_limit))->(p_limit-1) else null end
  ) into result from candidates c;
  return result;
end $$;

create or replace function public.get_photo_job_summaries_page(
  search_query text default null, p_limit integer default 200,
  p_after_activity timestamptz default null, p_after_number text default null, p_after_id uuid default null
)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 or
     (p_after_number is null)<>(p_after_id is null) or
     (p_after_id is null and p_after_activity is not null) or
     (p_after_activity is not null and not isfinite(p_after_activity)) then
    raise exception 'invalid_input';
  end if;
  with summaries as (
    select s.*,case when s.job_number ~ '^[0-9]+$' then lpad(s.job_number,20,'0') else s.job_number end as number_key
    from public.get_photo_job_summaries(search_query) s
  ), candidates as (
    select s.*,row_number() over(order by s.latest_upload desc nulls last,s.number_key desc,s.id) as position
    from summaries s
    where p_after_id is null
      or coalesce(s.latest_upload,'-infinity'::timestamptz)<coalesce(p_after_activity,'-infinity'::timestamptz)
      or (s.latest_upload is not distinct from p_after_activity and
        (s.number_key<p_after_number or (s.number_key=p_after_number and s.id>p_after_id)))
    order by s.latest_upload desc nulls last,s.number_key desc,s.id
    limit p_limit+1
  )
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(to_jsonb(c)-'position'-'number_key' order by position) filter(where position<=p_limit),'[]'::jsonb),
    'next_cursor',case when count(*)>p_limit then
      (jsonb_agg(jsonb_build_object('activity',c.latest_upload,'number',c.number_key,'id',c.id) order by position)
        filter(where position<=p_limit))->(p_limit-1) else null end
  ) into result from candidates c;
  return result;
end $$;
revoke all on function public.get_photo_album_summaries_page(text,integer,timestamptz,uuid) from public,anon;
revoke all on function public.get_photo_job_summaries_page(text,integer,timestamptz,text,uuid) from public,anon;
grant execute on function public.get_photo_album_summaries_page(text,integer,timestamptz,uuid) to authenticated,service_role;
grant execute on function public.get_photo_job_summaries_page(text,integer,timestamptz,text,uuid) to authenticated,service_role;

-- Grants, by name. `create or replace` keeps an existing ACL, but a rebuilt
-- database starts from baseline defaults that let clients execute everything.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_create_upload_attempt','photo_finalize_upload','photo_claim_content','photo_refresh_upload_outcome','photo_apply_action',
     'photo_create_album','photo_rename_album','photo_delete_album','photo_restore_album','photo_album_add','photo_album_remove','photo_bulk_tag') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal helpers: only the functions above call them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_same_photo_outcome','photo_clean_tags') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
revoke all on function public.get_photo_album_summaries(text) from public,anon;
grant execute on function public.get_photo_album_summaries(text) to authenticated,service_role;
commit;
