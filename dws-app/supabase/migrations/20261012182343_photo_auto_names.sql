-- Automatic photo names
-- (plans/active/dws-photos-client-feedback/plan.md, Phase W1-B; Decision 4; AC-5, AC-6).
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching app change. Additive only (the new
-- column has a default; re-created functions keep their parameter names), so the live app
-- keeps working; it already shows display_name when present.
--
-- The naming rule: Docs/photos-runbook.md § Hand-made projects; the format lives in
-- photo_auto_name below. original_name and the storage paths never change: MCP references and
-- import matching address photos by them.
--
-- WHAT CHANGES, function by function, is listed above each one. Each re-created function
-- starts from its latest definition and changes only the named lines. Grants are restated by
-- name at the end.
begin;

-- Who chose the name. NEW. A photo renamed by hand before this file keeps its name: the
-- marking runs only on the run that adds the column, so a re-run cannot mark automatic names
-- as hand-given.
do $$ begin
  if not exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='photos' and column_name='name_source') then
    alter table public.photos add column name_source text not null default 'auto'
      check (name_source in ('auto','manual'));
    update public.photos set name_source='manual' where display_name is not null;
  end if;
end $$;

-- Finds a name already held in the same project (or among project-less photos). NEW.
create index if not exists photos_active_display_name on public.photos(job_id,display_name) where deleted_at is null;

-- The automatic name for a photo in project p_job captured at p_captured. NEW, internal. The
-- format lives here and nowhere else. p_self is the photo being named, so its own current name
-- never counts as taken. Namings in the same project are serialized for the rest of the
-- transaction, so two uploads of the same second cannot both take the plain name. A slash in
-- an office job number (nothing forbids one) becomes '-', since a name may not hold one.
create or replace function public.photo_auto_name(p_job uuid,p_captured timestamptz,p_self uuid)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare num text; base text; candidate text; n integer := 1;
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-auto-name:'||coalesce(p_job::text,'none'),0));
  if p_job is not null then
    select regexp_replace(j.job_number,'[/\\]','-','g') into num from public.jobs j where j.id=p_job;
  end if;
  base:=to_char(p_captured at time zone 'America/Los_Angeles','YYMMDD HH24MISS');
  if num is not null then base:=num||' – '||base; end if;
  candidate:=base;
  loop
    if p_job is null then
      exit when not exists(select 1 from public.photos p where p.job_id is null and p.display_name=candidate
        and p.deleted_at is null and p.id is distinct from p_self);
    else
      exit when not exists(select 1 from public.photos p where p.job_id=p_job and p.display_name=candidate
        and p.deleted_at is null and p.id is distinct from p_self);
    end if;
    n:=n+1; candidate:=base||' ('||n||')';
  end loop;
  return candidate;
end $$;

-- Names a photo on insert, when its project changes, and when it comes back from Trash (its
-- name may have been taken while it was there), unless it was named by hand. A plain file
-- (kind 'file', a document) keeps its uploaded filename. NEW, internal.
create or replace function public.photo_auto_name_on_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.name_source<>'auto' or new.kind='file' then return new; end if;
  if tg_op='UPDATE' and new.job_id is not distinct from old.job_id
    and not (old.deleted_at is not null and new.deleted_at is null) then return new; end if;
  new.display_name:=public.photo_auto_name(new.job_id,new.captured_at,new.id);
  return new;
end $$;
drop trigger if exists photo_auto_name on public.photos;
create trigger photo_auto_name before insert or update of job_id,deleted_at on public.photos
  for each row execute function public.photo_auto_name_on_write();

-- Backfill. Active photos first, oldest capture first, so the earliest shot of a second keeps
-- the plain name; trashed photos are named too, in case they are restored. Only rows still
-- without a name, so a re-run does nothing.
do $$ declare r record; begin
  for r in select id from public.photos where name_source='auto' and display_name is null and kind<>'file'
    order by deleted_at is not null,captured_at,created_at,id loop
    update public.photos p set display_name=public.photo_auto_name(p.job_id,p.captured_at,p.id) where p.id=r.id;
  end loop;
end $$;

-- photo_rename_photo, from 20260923180000. CHANGED: the update sets name_source; a blank name
-- returns to the automatic name (recomputed; a plain file keeps none) instead of clearing it.
-- UNCHANGED: every other line.
create or replace function public.photo_rename_photo(p_actor uuid,p_photo uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n text := nullif(btrim(regexp_replace(coalesce(p_name,''),'\s+',' ','g')),''); p public.photos;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if char_length(n)>200 or n ~ '[/\\]' then raise exception 'photo_name_invalid'; end if;
  update public.photos set display_name=case when n is null and kind='file' then null else coalesce(n,public.photo_auto_name(job_id,captured_at,id)) end,
    name_source=case when n is null then 'auto' else 'manual' end
    where id=p_photo and deleted_at is null returning * into p;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('id',p.id,'display_name',p.display_name);
end $$;

-- photo_share_read, from 20260921040000. CHANGED: each photo also carries display_name, so a
-- share-link download is named like an in-app one (see point 4 of 20260921040000). UNCHANGED:
-- every other line.
create or replace function public.photo_share_read(p_token text,p_after jsonb default null,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare link public.photo_share_links; target_name text; total bigint; page jsonb; size integer; after_at timestamptz; after_id uuid; last jsonb;
begin
  -- [2] A closed gate is answered exactly like an unknown token. Read the switch directly, not
  -- through photo_require_gate: that raises, and an exception is a different answer.
  if not exists(select 1 from public.photo_release_state where singleton and schema_generation=1 and sharing_enabled) then return null; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
  select * into link from public.photo_share_links where token=p_token and revoked_at is null;
  if not found then return null; end if;
  -- [1][3] From here on the ONLY target is the one on the link's own row.
  if link.album_id is not null then
    select name into target_name from public.albums where id=link.album_id and deleted_at is null;
  else
    select name into target_name from public.jobs where id=link.job_id and is_active;
  end if;
  if target_name is null then return null; end if;
  size:=case when p_limit between 1 and 200 then p_limit else 100 end;
  -- A cursor is either absent or exactly what this function handed out: an object holding both
  -- keys. Anything else -- a bare string or number, an empty object, half a cursor, values that do
  -- not parse -- is a cursor this function did not make, and reads as nothing rather than as page one.
  if p_after is not null and jsonb_typeof(p_after)<>'null' then
    if jsonb_typeof(p_after)<>'object' or p_after->>'captured_at' is null or p_after->>'id' is null then return null; end if;
    begin
      after_at:=(p_after->>'captured_at')::timestamptz; after_id:=(p_after->>'id')::uuid;
    exception when others then return null;
    end;
  end if;
  -- [3] Membership for an album, project for a project; active photos only; images and videos only. [4]
  select count(*) into total from public.photos p
    where p.deleted_at is null and p.kind in ('image','video')
      and case when link.album_id is not null then exists(select 1 from public.album_photos ap where ap.album_id=link.album_id and ap.photo_id=p.id)
               else p.job_id=link.job_id end;
  -- [4] The column list below IS the privacy boundary. Add nothing to it without reading point 4.
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'kind',q.kind,'captured_at',q.captured_at,'original_name',q.original_name,'display_name',q.display_name,'mime_type',q.mime_type,
      'duration_secs',q.duration_secs,'original_path',q.original_path,'thumb_path',q.thumb_path,'preview_path',q.preview_path,'playback_path',q.playback_path)
      order by q.captured_at desc,q.id desc),'[]') into page
    from (select p.id,p.kind,p.captured_at,p.original_name,p.display_name,p.mime_type,p.duration_secs,p.original_path,p.thumb_path,p.preview_path,p.playback_path
      from public.photos p
      where p.deleted_at is null and p.kind in ('image','video')
        and case when link.album_id is not null then exists(select 1 from public.album_photos ap where ap.album_id=link.album_id and ap.photo_id=p.id)
                 else p.job_id=link.job_id end
        and (after_at is null or (p.captured_at,p.id)<(after_at,after_id))
      order by p.captured_at desc,p.id desc limit size) q;
  last:=page->(jsonb_array_length(page)-1);
  return jsonb_build_object('kind',case when link.album_id is not null then 'album' else 'project' end,'name',target_name,'count',total,'photos',page,
    'next_after',case when jsonb_array_length(page)=size then jsonb_build_object('captured_at',last->>'captured_at','id',last->>'id') end);
end $$;

-- Grants, by name.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_rename_photo','photo_share_read') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal: only the trigger and photo_rename_photo call them.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_auto_name','photo_auto_name_on_write') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
commit;
