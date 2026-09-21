-- Folders import as albums
-- (plans/active/photo-albums/plan.md, Phase 6; Decisions 9 and 10; AC-16 to AC-19).
--
-- WHEN TO APPLY: BEFORE the merge, after 20260921024651_photo_albums.sql (it uses the
-- albums tables and photo_same_photo_outcome from that file).
--
-- WHY IT IS SAFE FOR THE APP THAT IS LIVE TODAY:
--   * Schema changes only loosen or add: a source's project may be empty, one new table,
--     one new index. No existing row changes.
--   * Every existing function keeps its name, parameters, and parameter order. No
--     signature changes, so nothing is dropped and no call becomes ambiguous.
--   * The live app always names a project for every source. For such a source every
--     folder row starts with that project, so each imported photo gets the project it
--     gets today. The one visible difference before the deploy: a folder import run from
--     the old page also produces one album per folder. Premise P3 (no import has run)
--     and the rollout gate (the big import waits for this phase) make that moot.
--   * A migration item with no folder row (a batch sealed before this file) keeps today's
--     behaviour exactly: the source's project, no album, tags from the request.
--
-- WHAT CHANGES, function by function, is listed above each one. Each re-created function
-- starts from its latest definition across ALL migration files and changes only the named
-- lines. No new function checks a role (Decision 7). Grants are restated BY NAME at the
-- end, never with a blanket loop.
begin;

-- A source's project is now only a default for its folder rows.
alter table public.migration_sources alter column job_id drop not null;

-- One row per folder that directly holds importable photos: the unit of import choices
-- (Decision 10). `folder` is the path under the picked folder, '' for the folder itself.
-- album_name is null only for loose files, where an album is optional (AC-18).
-- album_id is set once, when the first photo lands (or, for loose files, when the
-- employee picks an existing album). photo_count and created_scan_id are bookkeeping:
-- the count review shows, and which seal made the row (so suggestions run once per row).
create table if not exists public.migration_folders (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.migration_sources(id),
  folder text not null check (folder !~ '^/' and folder !~ '/$' and folder !~ '(^|/)\.\.(/|$)'),
  album_name text check (album_name is null or char_length(album_name) between 1 and 120),
  album_id uuid references public.albums(id),
  job_id uuid references public.jobs(id),
  tags text[] not null default '{}',
  photo_count integer not null default 0 check (photo_count>=0),
  created_scan_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, folder)
);
-- A private ledger like the other migration tables: no browser role reads or writes it.
alter table public.migration_folders enable row level security;
revoke all on table public.migration_folders from public,anon,authenticated;
grant all on table public.migration_folders to service_role;

-- Phase 6 Step 5. canonical_photo_id is a foreign key with ON DELETE SET NULL and had no
-- index, so deleting any photo scanned every migration item. Partial: almost every row is
-- null, and `canonical_photo_id = $1` implies the predicate, so the key's own lookup uses it.
-- Not CONCURRENTLY on purpose: premise P3 says the table is empty in production, and a
-- plain index keeps this file transactional.
create index if not exists migration_items_canonical_photo on public.migration_items(canonical_photo_id)
  where canonical_photo_id is not null;

-- The density-zero statistics state below is reproduced by the local fixture. Its
-- occurrence in production has not been established; this setting is defensive,
-- not evidence that ordinary table growth causes the measured cliff.
-- Phase 6 Step 5, the row-count cliff. Captured with auto_explain on a throwaway database
-- holding 1,500 photos whose table statistics still said "empty" (pg_class reltuples=0,
-- relpages=1, which is what an index build or vacuum records on a table that has pages but
-- no live rows; the planner then multiplies a density of zero by any file size and gets 1 row):
--
--   Nested Loop                        (actual time=14652 ms)
--     Join Filter: (n_1.photo_id = p.id)
--     Rows Removed by Join Filter: 150000000
--     -> Seq Scan on photos p          (estimated rows=1, actual rows=1500)
--     -> Named Tuplestore Scan         (rows=100000, loops=1500)
--
-- Believing photos held one row, the planner put it on the OUTSIDE and re-read the whole
-- 100,000-row insert once per photo. Sealing went from 1.7 s to 11.5 s (16.6 s with
-- instrumentation), and the cost grows with the library, so after a real import it would
-- not finish. The sibling check against photo_upload_attempts got the healthy shape in the
-- same statement (the inserted rows drive, one index probe each: 25 ms).
--
-- Fixed at the source rather than with an `analyze`. The damage is multiplicative -- every
-- inserted row times every row of the other table -- and only a nested loop can do that. A
-- hash or merge join reads each side once whatever the estimates say, whichever side it
-- hashes, and whichever index or scan feeds it. So these two functions switch nested loops
-- off for their own duration (a function-level SET, restored on exit). Their query text is
-- unchanged.
--
-- Measured on one throwaway database, statistics confirmed stale before each comparison
-- (100,000-entry seal, no instrumentation):
--     old body, 1,500 photos                    13.5 s
--     this file, 1,500 photos                    2.3 s   (each check: one Hash Join, every node loops=1;
--     this file, 20,000 photos                   2.8 s    the photos check alone 14,652 ms -> 12 ms)
--     10-entry seal, 20,000 photos: old 9 ms, this file 10 ms  -- the price of reading a table
--                                                                once instead of probing an index
--
-- Tried first and rejected: rewriting each join as `cross join lateral (... limit 1)`. It does
-- pin the join ORDER (the inserted rows drive), and at 1,500 photos it looked fixed (3.0 s). But
-- a lateral IS a nested loop, and under the same stale statistics every index on photos looked
-- equally cheap: the planner probed photos_uploader_captured_id, where id is a trailing column,
-- so each of the 100,000 probes walked the whole index. That is still every-row-times-every-row:
-- at 20,000 photos it took 12.0 s, back over the cliff. Timing at one library size would have
-- passed it; the captured plan did not.
--
-- migration_reserve_uuids, from 20260907100300_photo_migrations.sql (its only definition).
-- CHANGED: the header gains `set enable_nestloop=off`. Nothing else.
-- UNCHANGED: the body, the conflict it raises, and the trigger that calls it (not re-created).
create or replace function public.migration_reserve_uuids()
returns trigger language plpgsql security definer set search_path=public,pg_temp set enable_nestloop=off as $$
begin
  if exists(select 1 from reserved_items n join public.photo_upload_attempts a on a.photo_id=n.photo_id)
    or exists(select 1 from reserved_items n join public.photos p on p.id=n.photo_id)
  then raise exception 'conflict'; end if;
  return null;
end $$;

-- photo_repair_guard_owner_ids, from 20260907100500_photo_repair.sql (its only definition).
-- It runs on the same 100,000-row insert with the same join shape. Measured, not assumed:
-- with photo_repair_retired_ids holding 1,500 rows under the same stale statistics, the seal
-- took 13.2 s through the old body. (It also runs after every insert into
-- photo_upload_attempts, where it now reads the small retired-ids table once.)
-- CHANGED: the header gains `set enable_nestloop=off`. Nothing else.
-- UNCHANGED: the body, the conflict it raises, and both triggers that call it (not re-created).
create or replace function public.photo_repair_guard_owner_ids()
returns trigger language plpgsql security definer set search_path=public,pg_temp set enable_nestloop=off as $$
begin
  if exists(select 1 from new_owners n join public.photo_repair_retired_ids r on r.id=n.photo_id) then raise exception 'conflict'; end if;
  return null;
end $$;

-- photo_guard_source_mapping, from 20260907100100_hosted_photo_authority.sql (its only
-- definition). The trigger it backs already exists and is not re-created.
-- CHANGED: one condition. A source may now name no project, so the "project must be
--   active" check applies only when there is one.
-- UNCHANGED: every other line, including the freeze of a source's mapping after approval.
create or replace function public.photo_guard_source_mapping()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare state text; batch uuid;
begin
  if tg_op='UPDATE' and new.batch_id is distinct from old.batch_id then raise exception 'conflict'; end if;
  batch:=case when tg_op='DELETE' then old.batch_id else new.batch_id end;
  select status into state from public.migration_batches where id=batch for update;
  if tg_op in ('INSERT','DELETE') and state<>'draft' then raise exception 'conflict'; end if;
  if tg_op='UPDATE' and state<>'draft' and (new.batch_id,new.job_id,new.kind,new.selection_rules) is distinct from (old.batch_id,old.job_id,old.kind,old.selection_rules) then raise exception 'conflict'; end if;
  if tg_op<>'DELETE' and new.job_id is not null and not exists(select 1 from public.jobs where id=new.job_id and is_active) then raise exception 'invalid_input'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;

-- migration_source, from 20260907100300_photo_migrations.sql.
-- CHANGED: one condition. p_job may be null ("no default project"); a named project must
--   still be active.
-- UNCHANGED: every other line. Changing a source's default project still clears its scan,
--   so the folder rows are derived again from the new default before anything is approved.
create or replace function public.migration_source(p_actor uuid,p_batch uuid,p_source uuid,p_job uuid,p_kind text,p_label text,p_rules jsonb)
returns public.migration_sources language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches; s public.migration_sources;
begin
  b:=public.migration_lock_batch(p_actor,p_batch);
  if b.status<>'draft' then raise exception 'conflict'; end if;
  if (p_job is not null and not exists(select 1 from public.jobs where id=p_job and is_active)) or p_kind not in ('directory','files') or p_label is null or length(p_label) not between 1 and 512 then raise exception 'invalid_input'; end if;
  if b.script_name='add_photos' and (p_kind<>'files' or exists(select 1 from public.migration_sources where batch_id=p_batch and id<>p_source)) then raise exception 'conflict'; end if;
  select * into s from public.migration_sources where id=p_source;
  if found and s.batch_id<>p_batch then raise exception 'conflict'; end if;
  insert into public.migration_sources(id,batch_id,job_id,kind,label,selection_rules) values(p_source,p_batch,p_job,p_kind,p_label,p_rules)
  on conflict(id) do update set job_id=excluded.job_id,kind=excluded.kind,label=excluded.label,selection_rules=excluded.selection_rules,scan_id=case when (migration_sources.job_id,migration_sources.kind,migration_sources.selection_rules) is distinct from (excluded.job_id,excluded.kind,excluded.selection_rules) then null else migration_sources.scan_id end,updated_at=clock_timestamp() returning * into s;
  return s;
end $$;

-- Decision 9: an album is named from the folder's path under the picked folder, joined
-- with " – ". The picked folder itself ('') takes the picked folder's own name. NEW, internal.
-- Each part is trimmed and its inner spaces collapsed, the rule photo_job_name applies to
-- a whole name. Albums allow 120 characters: a longer path keeps its END, the most
-- specific part, behind a leading "…".
create or replace function public.migration_album_name(p_label text,p_folder text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare parts text[]; name text;
begin
  parts:=case when coalesce(p_folder,'')='' then array[coalesce(p_label,'')] else string_to_array(p_folder,'/') end;
  select array_agg(q.part order by q.ord) into parts from (
    select btrim(regexp_replace(u.part,'\s+',' ','g')) as part,u.ord from unnest(parts) with ordinality u(part,ord)) q where q.part<>'';
  if parts is null then return 'Imported photos'; end if;
  name:=array_to_string(parts,' – ');
  while char_length(name)>120 and cardinality(parts)>1 loop
    parts:=parts[2:]; name:='… – '||array_to_string(parts,' – ');
  end loop;
  if char_length(name)>120 then name:=left(name,119)||'…'; end if;
  return name;
end $$;

-- The albums one upload joins. NEW, internal: like photo_same_photo_outcome, no role may
-- call it; only the three upload functions below do.
--   * An ordinary upload, or a migration item with no folder row: the list the owner
--     already carries. Nothing changes for them.
--   * A migration item with a folder row: that row's album. The album is created HERE,
--     once, the first time a photo is really about to land in it -- p_creating says a new
--     photo row is being inserted; otherwise it is created only when the bytes already
--     exist as an ACTIVE photo, which the same-photo rule then adds to it (AC-7).
--     So resume, rescan, and retry reuse album_id and never make a second album, and a
--     folder whose photos all fail, are skipped, or sit in trash leaves no album (AC-16).
--   * A deleted album still receives photos, as in photo_same_photo_outcome: the import
--     named it while it was live, and restoring it should show the whole folder.
-- Callers hold the batch lock (photo_lock_upload), which serializes every upload in one
-- batch, and a folder row belongs to exactly one batch. Lock order: owner, digest, folder, photo.
create or replace function public.migration_upload_albums(p_actor uuid,p_owner_kind text,p_upload jsonb,p_digest text,p_creating boolean)
returns uuid[] language plpgsql security definer set search_path=public,pg_temp as $$
declare folder public.migration_folders; album uuid;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_owner_kind is distinct from 'migration' or p_upload->>'folder_id' is null then
    return array(select jsonb_array_elements_text(p_upload->'album_ids'))::uuid[];
  end if;
  select * into folder from public.migration_folders where id=(p_upload->>'folder_id')::uuid for update;
  if not found then return '{}'; end if;
  if folder.album_id is not null then return array[folder.album_id]; end if;
  if folder.album_name is null then return '{}'; end if;
  if not coalesce(p_creating,false) and not exists(select 1 from public.photos where content_sha256=p_digest and deleted_at is null) then return '{}'; end if;
  insert into public.albums(name,created_by) values(folder.album_name,p_actor) returning id into album;
  update public.migration_folders set album_id=album,updated_at=clock_timestamp() where id=folder.id;
  return array[album];
end $$;

-- The folder that directly holds a file: 'a/b/c.jpg' -> 'a/b', 'c.jpg' -> ''. NEW, internal.
-- Must agree with folderOf() in src/lib/photos/migration/folders.ts.
create or replace function public.migration_folder_of(p_relative_path text)
returns text language sql immutable set search_path=public,pg_temp as $$
  select regexp_replace(p_relative_path,'/?[^/]*$','');
$$;

-- photo_lock_upload, from 20260907100300_photo_migrations.sql (the latest of three).
-- CHANGED, migration owners only: the item's folder row is read (after the batch lock, so
--   it cannot change underneath) and supplies what the upload functions read from `v`:
--     job_id       the row's project, EVEN WHEN EMPTY -- the row is the authority, so a
--                  folder reviewed as "No project" imports with none;
--     album_ids    the row's album once it exists, else empty;
--     album_pending  true while the row names an album that has not been created yet;
--     folder_id, folder_tags  for migration_upload_albums and photo_finalize_upload.
--   An item with no folder row (sealed before this file) gets none of these keys and keeps
--   the source's project, exactly as before.
-- UNCHANGED: ordinary owners, every lock, and every status, lease, and retry check.
create or replace function public.photo_lock_upload(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; batch uuid; batch_status text; job uuid; folder public.migration_folders;
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
    select f.* into folder from public.migration_folders f join public.migration_items i on i.source_id=f.source_id
      where i.id=p_owner_id and f.folder=public.migration_folder_of(i.relative_path);
    select to_jsonb(i) || jsonb_build_object('actor_id',p_actor,'job_id',case when folder.id is null then job else folder.job_id end)
      || case when folder.id is null then '{}'::jsonb else jsonb_build_object('folder_id',folder.id,'folder_tags',to_jsonb(folder.tags),
        'album_ids',case when folder.album_id is null then '[]'::jsonb else jsonb_build_array(folder.album_id) end,
        'album_pending',folder.album_id is null and folder.album_name is not null) end
      into v from public.migration_items i where i.id=p_owner_id for update;
    if not (v->>'is_current')::boolean or v->>'status' in ('skipped_missing','skipped_unsupported','skipped_failed','skipped_user') then raise exception 'conflict'; end if;
    if (v->>'retryable')::boolean=false or (v->>'retry_after')::timestamptz>clock_timestamp() then raise exception 'conflict'; end if;
    if batch_status not in ('approved','running') and not coalesce((v->'result'<>'null'::jsonb),false) then raise exception 'conflict'; end if;
  else raise exception 'invalid_input'; end if;
  if v->>'status'='cancelled' and coalesce(v->'result','null'::jsonb)='null'::jsonb then raise exception 'conflict'; end if;
  return v;
end $$;

-- photo_refresh_upload_outcome, from 20260921024651_photo_albums.sql.
-- CHANGED: one argument. The album list comes from migration_upload_albums, so an import
--   item whose trashed copy was restored joins its folder's album, creating it if needed.
-- UNCHANGED: every other line. For an ordinary upload the helper returns the same list.
create or replace function public.photo_refresh_upload_outcome(p_actor uuid,p_owner_kind text,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; outcome jsonb; state text;
begin
  v:=public.photo_lock_upload(p_actor,p_owner_kind,p_owner_id);
  if v->>'status' not in ('job_conflict','restore_required') or coalesce(v->'result','null'::jsonb)='null'::jsonb then return v->'result'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v->>'content_sha256',0));
  outcome:=public.photo_same_photo_outcome(p_actor,v->>'content_sha256',(v->>'job_id')::uuid,public.migration_upload_albums(p_actor,p_owner_kind,v,v->>'content_sha256',false));
  -- A purged canonical never reactivates paths already eligible for cleanup.
  if outcome is null then return (v->'result')||jsonb_build_object('new_attempt_required',true); end if;
  state:=case when outcome->>'status'='duplicate_trashed' then 'restore_required'
    when outcome->>'job_id'<>v->>'job_id' then 'job_conflict' else 'skipped_duplicate' end;
  if p_owner_kind='ordinary' then update public.photo_upload_attempts set status=state,result=outcome,updated_at=clock_timestamp() where id=p_owner_id;
  else update public.migration_items set status=state,result=outcome,canonical_photo_id=(outcome->>'photo_id')::uuid,
    canonical_job_id=(outcome->>'job_id')::uuid,updated_at=clock_timestamp() where id=p_owner_id; end if;
  return outcome;
end $$;

-- photo_claim_content, from 20260921024651_photo_albums.sql.
-- This is where a folder of copies is normally caught, before any bytes move (AC-7).
-- CHANGED: one argument. The album list comes from migration_upload_albums, which creates
--   the folder's album only when these bytes already exist as an active photo.
-- UNCHANGED: every other line. For an ordinary upload the helper returns the same list.
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
  outcome:=public.photo_same_photo_outcome(p_actor,digest,(v->>'job_id')::uuid,public.migration_upload_albums(p_actor,p_owner_kind,v,digest,false));
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

-- photo_finalize_upload, from 20260921024651_photo_albums.sql. Signature unchanged.
-- CHANGED, five things, all inert for an ordinary upload (the helper returns its list
--   unchanged, album_pending and folder_id are absent):
--   1. the "names neither a project nor an album" refusal also accepts an import folder
--      whose album is named but not created yet (album_pending);
--   2. both late-duplicate lookups take their album list from migration_upload_albums, which
--      creates the folder's album only when the bytes exist as an active photo;
--   3. just before a NEW photo row is inserted, the folder's album is created
--      (p_creating=true). It sits INSIDE the block that catches unique_violation, so if the
--      insert loses that race the album's creation is rolled back with it;
--   4. a new import photo takes its folder row's tags, not the request's: nothing is
--      assigned that review did not show (AC-17). An item with no folder row, and every
--      ordinary upload, still takes the request's tags;
--   5. `albums` is declared before use exactly as before; it is now reassigned at 2 and 3.
-- UNCHANGED: replay, lease, path binding, size verification, the claim check, and the
--   insert's column list.
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
  if digest is null or digest !~ '^[0-9a-f]{64}$' or (job is null and cardinality(albums)=0 and not coalesce((v->>'album_pending')::boolean,false))
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
  albums:=public.migration_upload_albums(p_actor,p_owner_kind,v,digest,false);
  outcome:=public.photo_same_photo_outcome(p_actor,digest,job,albums); v_warnings:=coalesce(p_photo->'warnings','[]');
  if outcome is null then
    begin
      albums:=public.migration_upload_albums(p_actor,p_owner_kind,v,digest,true);
      insert into public.photos(id,job_id,uploader_id,kind,tags,captured_at,captured_at_source,original_path,original_bytes,mime_type,original_name,
        thumb_path,preview_path,sidecar_path,sidecar_name,duration_secs,content_sha256,upload_attempt_id,migration_item_id,upload_warnings)
      values(photo,job,p_actor,p_photo->>'kind',case when v ? 'folder_id' then coalesce(array(select jsonb_array_elements_text(v->'folder_tags')),'{}') else coalesce(array(select jsonb_array_elements_text(p_photo->'tags')),'{}') end,
        coalesce((p_photo->>'captured_at')::timestamptz,clock_timestamp()),coalesce(p_photo->>'captured_at_source','upload'),path,original_size,v->>'mime_type',v->>'original_name',
        p_photo->>'thumb_path',p_photo->>'preview_path',p_photo->>'sidecar_path',p_photo->>'sidecar_name',(p_photo->>'duration_secs')::numeric,digest,
        case when p_owner_kind='ordinary' then p_owner_id else (v->>'upload_attempt_id')::uuid end,case when p_owner_kind='migration' then p_owner_id end,v_warnings);
      insert into public.album_photos(album_id,photo_id,added_by)
        select al.id,photo,p_actor from public.albums al where al.id=any(albums) on conflict do nothing;
      outcome:=jsonb_build_object('status','created','photo_id',photo,'job_id',job);
    exception when unique_violation then
      albums:=public.migration_upload_albums(p_actor,p_owner_kind,v,digest,false);
      outcome:=public.photo_same_photo_outcome(p_actor,digest,job,albums); if outcome is null then raise exception 'conflict'; end if;
    end;
  end if;
  perform public.photo_record_upload_outcome(p_actor,p_owner_kind,p_owner_id,p_generation,job,outcome,p_photo);
  return outcome;
end $$;

-- A source's default tags, from its selection_rules. NEW, internal. The rules object is
-- stored as the browser sent it, so anything that is not a clean tag list reads as "no tags"
-- instead of failing the seal.
create or replace function public.migration_default_tags(p_rules jsonb)
returns text[] language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if p_rules is null or jsonb_typeof(p_rules->'tags') is distinct from 'array' then return '{}'; end if;
  return public.photo_clean_tags(array(select jsonb_array_elements_text(p_rules->'tags')));
exception when others then return '{}';
end $$;

-- migration_seal, from 20260907100300_photo_migrations.sql. Signature unchanged; p_job may
-- now be null, and `is distinct from` already compared it correctly.
-- CHANGED: one added block, after the items are reconciled and before the source is marked
--   sealed -- the folder rows are derived from the sealed inventory (Decision 10):
--   * one row per folder that directly holds at least one importable current item (not
--     excluded as unsupported, not missing). photo_count is refreshed on every seal; a row
--     whose folder no longer holds anything keeps its choices and reads 0. Rows are never
--     deleted here, so a rescan cannot lose a choice or an album that already exists;
--   * a NEW row is named from its path (folders) or left without an album (loose files), and
--     starts from the source's default project and tags. That holds for a folder that first
--     appears on a later draft rescan too. An approved rescan refuses new folders before
--     changing any inventory; they must be reviewed in a new import. A new row deliberately
--     does NOT copy a parent row's choices: a
--     parent has a row only when it directly holds photos, so copying would work in one
--     folder layout and silently not in another. Review lists the new row before anything
--     is imported into it;
--   * an existing row's album name, project, and tags are never touched: only the employee
--     changes those, and only while the batch is a draft.
-- UNCHANGED: every check, the set-based reconciliation, and the missing-file rule.
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
    select p_source,c.folder,case when s.kind='directory' then public.migration_album_name(s.label,c.folder) end,
      s.job_id,public.migration_default_tags(s.selection_rules),c.photos,p_scan
    from (select public.migration_folder_of(i.relative_path) as folder,count(*)::integer as photos from public.migration_items i
      where i.source_id=p_source and i.is_current and i.status not in ('skipped_unsupported','skipped_missing') group by 1) c
  on conflict(source_id,folder) do update set photo_count=excluded.photo_count,updated_at=clock_timestamp();
  update public.migration_sources set sealed_scan_id=p_scan,sealed_fingerprint=fingerprint,sealed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_source returning * into s;
  return s;
end $$;

-- migration_batch_action, from 20260907100300_photo_migrations.sql.
-- CHANGED: `approve` gains one check before it records the approval. Every folder row that
--   holds photos must name a project or an album (AC-18: for a folder the album name is
--   always there, so this only ever stops loose files with neither), and whatever it names
--   must still be usable: the project active, a chosen existing album not deleted. Approval
--   is what freezes the rows, so this is the last moment to refuse.
-- UNCHANGED: every other action, and the approved_rules snapshot. The rows themselves are
--   the record of what was approved; migration_guard_folder keeps them fixed from here on.
create or replace function public.migration_batch_action(p_actor uuid,p_batch uuid,p_action text)
returns public.migration_batches language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.migration_batches; rules jsonb;
begin
  b:=public.migration_lock_batch(p_actor,p_batch);
  if p_action='cancel' then perform public.photo_cancel_migration(p_actor,p_batch);
  elsif p_action='approve' then
    if b.status<>'draft' then raise exception 'conflict'; end if;
    if exists(select 1 from public.migration_folders f join public.migration_sources s on s.id=f.source_id
      where s.batch_id=p_batch and f.photo_count>0 and (
        (f.job_id is null and f.album_id is null and f.album_name is null)
        or (f.job_id is not null and not exists(select 1 from public.jobs j where j.id=f.job_id and j.is_active))
        or (f.album_id is not null and not exists(select 1 from public.albums al where al.id=f.album_id and al.deleted_at is null))))
    then raise exception 'invalid_input'; end if;
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

-- Edit folder rows during review. NEW. Only the batch's creator, and only while it is a draft
-- (migration_lock_batch checks the actor and both gates).
--   p_folder      the row to change; with p_subfolders, that folder AND everything inside it
--                 ('' is the picked folder, so it reaches every row of the source). This is
--                 how a choice on a top-level folder applies to the folders inside it
--                 (Decision 10) -- including a top-level folder that holds no photos itself
--                 and so has no row of its own. It applies to the rows that exist now.
--   p_patch       any of: job_id (uuid or null = "No project"), tags (array),
--                 album_name (text, or null), album_id (uuid or null). Nothing else.
-- A name is one folder's, so album_name and album_id refuse p_subfolders.
--   * Folders: album_name null or blank restores the name from the path; a folder always
--     becomes an album (Decision 9), and album_id is refused.
--   * Loose files: an album is optional (AC-18). album_name = a new album; album_id = an
--     existing, live one; setting either clears the other; null clears it.
-- Tags follow Decision 5: a tag matching one already on an active photo, ignoring case,
-- takes that spelling (the rule photo_bulk_tag applies). Returns {updated: <rows>}.
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
    next_name:=nullif(btrim(coalesce(p_patch->>'album_name','')),'');
    if next_name is not null then next_name:=public.photo_job_name(next_name);
    elsif s.kind='directory' then next_name:=public.migration_album_name(s.label,p_folder); end if;
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

-- Record project suggestions for rows a seal just created (AC-17). NEW. The matching itself
-- (a project number as a whole word in a folder name) is suggestFolderProjects() in
-- src/lib/photos/migration/folders.ts, run by the seal route; this only stores its answer.
-- It can never override anything: it touches only rows made by THIS scan that still have no
-- project, only while the batch is a draft, and only with an active project. Review shows
-- every suggestion before it is used. p_rows: [{folder, job_id}], at most 1000 per call.
create or replace function public.migration_folder_suggest(p_actor uuid,p_source uuid,p_scan uuid,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.migration_sources; b public.migration_batches; n_updated integer;
begin
  select * into s from public.migration_sources where id=p_source;
  if not found then raise exception 'not_found'; end if;
  b:=public.migration_lock_batch(p_actor,s.batch_id);
  if b.status<>'draft' then raise exception 'conflict'; end if;
  if p_scan is null or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'invalid_input'; end if;
  update public.migration_folders f set job_id=r.job_id,updated_at=clock_timestamp()
    from jsonb_to_recordset(p_rows) as r(folder text,job_id uuid)
    where f.source_id=p_source and f.folder=r.folder and f.created_scan_id=p_scan and f.job_id is null
      and exists(select 1 from public.jobs j where j.id=r.job_id and j.is_active);
  get diagnostics n_updated=row_count;
  return jsonb_build_object('updated',n_updated);
end $$;

-- Rows are editable while the batch is a draft and frozen on approve (Decision 10). NEW.
-- The functions above already refuse; this holds the line for any other writer, the way
-- photo_guard_source_mapping does for a source's mapping. After approval a row may still
-- have its photo count refreshed by a rescan, and gain its album ONCE (album_id null -> set):
-- that single transition is what "the album is created once per row" means in data (AC-16).
create or replace function public.migration_guard_folder()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare state text;
begin
  if (new.source_id,new.folder) is distinct from (old.source_id,old.folder) then raise exception 'conflict'; end if;
  -- Count refreshes touch none of the guarded columns: skip the batch lookup for them.
  if (new.album_name,new.job_id,new.tags,new.album_id) is not distinct from (old.album_name,old.job_id,old.tags,old.album_id) then return new; end if;
  select b.status into state from public.migration_batches b join public.migration_sources s on s.batch_id=b.id where s.id=new.source_id;
  if state is distinct from 'draft' and ((new.album_name,new.job_id,new.tags) is distinct from (old.album_name,old.job_id,old.tags)
    or old.album_id is not null) then raise exception 'conflict'; end if;
  return new;
end $$;
drop trigger if exists migration_guard_folder on public.migration_folders;
create trigger migration_guard_folder before update on public.migration_folders for each row execute function public.migration_guard_folder();

-- Grants, by name. `create or replace` keeps an existing ACL, but a rebuilt database starts
-- from baseline defaults that let clients execute everything.
do $$ declare f record; begin
  -- Called by the app through the service role. The three trigger functions keep the
  -- service_role grant their original files gave them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('migration_source','migration_seal','migration_batch_action','migration_folder_update','migration_folder_suggest',
     'photo_lock_upload','photo_claim_content','photo_refresh_upload_outcome','photo_finalize_upload',
     'migration_reserve_uuids','photo_repair_guard_owner_ids','photo_guard_source_mapping') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal helpers and the new trigger function: only the functions above call them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('migration_upload_albums','migration_album_name','migration_folder_of','migration_default_tags','migration_guard_folder') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
commit;
