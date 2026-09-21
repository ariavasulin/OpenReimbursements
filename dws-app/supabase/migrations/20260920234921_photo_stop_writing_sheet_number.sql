-- Sheet # is removed outright (plans/active/photo-albums/plan.md, Decision 6).
-- This is the photo field `photos.sheet_number`. It has nothing to do with the
-- pop-up containers the app calls SheetShell / FullScreenSheet.
--
-- This is the first of two files. It stops the database WRITING the column.
-- The next file (20260920235021_photo_drop_sheet_number.sql) DROPS it.
--
-- WHEN TO APPLY: BEFORE the merge, together with the other additive migrations.
--   Why it is safe under the app that is live today: that app may still send a
--   sheet number with an upload. This version of photo_finalize_upload simply
--   does not store it. No production photo uses Sheet # (premise P1), so
--   nothing anyone relies on is lost.
--   Why it is a separate file: a later migration re-creates
--   photo_finalize_upload again (optional project, albums). The column drop must
--   run AFTER the deploy, which is after that later migration. If the drop file
--   also re-created this function, it would overwrite the newer version.
--
-- WHAT CHANGES: two functions whose bodies name the column are re-created from
-- their latest definitions, changing only the column reference:
--   * photo_finalize_upload (from 20260907100200_hosted_photo_uploads.sql) no
--     longer inserts `sheet_number`. Every lease, claim, path-binding,
--     size-verification and duplicate check is unchanged.
--   * photo_install_write_boundary (from
--     20260907100100_hosted_photo_authority.sql) grants `update(tags)` instead of
--     `update(sheet_number,tags)`. It KEEPS its role='admin' check: it is a
--     deployment tool, not an app feature (Decision 7).
begin;

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
      insert into public.photos(id,job_id,uploader_id,kind,tags,captured_at,captured_at_source,original_path,original_bytes,mime_type,original_name,
        thumb_path,preview_path,sidecar_path,sidecar_name,duration_secs,content_sha256,upload_attempt_id,migration_item_id,upload_warnings)
      values(photo,job,p_actor,p_photo->>'kind',coalesce(array(select jsonb_array_elements_text(p_photo->'tags')),'{}'),
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
  grant update(tags) on public.photos to authenticated;
  for pol in select policyname from pg_policies where schemaname='public' and tablename='photos' and cmd in ('INSERT','DELETE','UPDATE','ALL') loop
    execute format('drop policy %I on public.photos',pol.policyname);
  end loop;
  create policy photos_update on public.photos for update to authenticated using(deleted_at is null) with check(deleted_at is null);
  drop trigger if exists photo_guard_direct_write on public.photos;
  create trigger photo_guard_direct_write before insert or update or delete on public.photos for each row execute function public.photo_guard_direct_write();
  update public.photo_release_state set write_boundary_installed_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by=p_actor where singleton;
end $$;

-- `create or replace` keeps the existing ACL; re-state it for a rebuilt
-- database. Scoped by name on purpose: a blanket `photo_%` loop would hand
-- photo_record_upload_outcome back to service_role.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_finalize_upload','photo_install_write_boundary') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
