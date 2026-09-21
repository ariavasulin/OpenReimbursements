-- Share links for albums and projects
-- (plans/active/photo-albums/plan.md, Phase 7; Decision 12; AC-21 to AC-23; § Security and privacy).
--
-- WHEN TO APPLY: BEFORE the merge, after 20260921035400_photo_import_albums.sql.
--
-- WHY IT IS SAFE FOR THE APP THAT IS LIVE TODAY: it only adds. One new table, one new column
-- with a default, three new functions, and one new accepted value for photo_require_gate; every
-- value that function already accepted behaves exactly as before. `sharing_enabled` starts
-- FALSE, so after this file is applied no share page works anywhere until an operator opens it
-- (Docs/photos-runbook.md, "Share links").
--
-- THE SECURITY CONTRACT this file must hold. It is the only surface reachable without a login.
--   1. photo_share_read is the ONLY query path for the public page. It takes its target from the
--      token's own row and from nothing else: it has no album, project, or photo parameter.
--   2. Unknown, malformed, revoked, and gate-closed tokens all produce the same answer: NULL.
--      No exception, no distinct code, so the route can answer one identical 404 for all of them.
--   3. A token for album A lists only photos that are members of A; a token for a project, only
--      photos whose project it is. Trashed photos are never listed. A deleted album shares nothing.
--   4. The answer carries the target's name, a count, and per photo: id, kind, capture date, file
--      name, type, duration, and image addresses. Never an uploader, a tag, a sidecar (XMP) path
--      or name, another album, a project number, or the link's own bookkeeping. Only images and
--      videos are listed, so a stray XMP stored as a file can never appear.
--   5. The token table grants nothing to `anon` or `authenticated`. The token is stored as-is
--      (Decision 12: so the link can be shown again), which is why no browser role may read it.
-- No new function checks a role: any signed-in employee may share (Decision 7).
-- Grants are restated BY NAME at the end.
begin;

alter table public.photo_release_state add column if not exists sharing_enabled boolean not null default false;

create table if not exists public.photo_share_links (
  id uuid primary key default gen_random_uuid(),
  -- 32 random bytes, base64url without padding: always exactly 43 characters.
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{43}$'),
  album_id uuid references public.albums(id),
  job_id uuid references public.jobs(id),
  created_by uuid not null references public.user_profiles(user_id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profiles(user_id),
  check (num_nonnulls(album_id,job_id)=1),
  check ((revoked_at is null)=(revoked_by is null))
);
-- At most one un-revoked link per target. These also serve every lookup by target.
create unique index if not exists photo_share_links_live_album on public.photo_share_links(album_id) where revoked_at is null and album_id is not null;
create unique index if not exists photo_share_links_live_job on public.photo_share_links(job_id) where revoked_at is null and job_id is not null;
-- Baseline default privileges grant ALL to clients; RLS alone does not stop TRUNCATE. Strip everything.
alter table public.photo_share_links enable row level security;
revoke all on table public.photo_share_links from public,anon,authenticated;
grant all on table public.photo_share_links to service_role;

-- photo_require_gate, from 20260907100100_hosted_photo_authority.sql (its only definition).
-- CHANGED: one added case, 'sharing' -> sharing_enabled.
-- UNCHANGED: 'writes', 'mcp', 'repair', the refusal of any other name, and the error raised.
create or replace function public.photo_require_gate(p_gate text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.photo_release_state where singleton and schema_generation=1 and
    case p_gate when 'writes' then photo_writes_enabled when 'mcp' then mcp_enabled when 'repair' then repair_enabled when 'sharing' then sharing_enabled else false end for share)
  then raise exception 'photo_gate_closed'; end if;
end $$;

-- Turn the link for one album or one project on or off. NEW. Exactly one of p_album / p_job.
--   on:  the target must be live (album not deleted, project active). If a link is already on,
--        the SAME one is returned, so pressing the switch twice changes nothing. Otherwise a NEW
--        token is made: turning a link on again never brings an old address back to life.
--   off: the live link is revoked, recording who and when. Off when already off changes nothing.
-- Turning a link off stops the page. It cannot recall image addresses someone already saved: the
-- storage bucket is public (Decision 12). The pop-up says so in plain words.
-- The sharing gate does NOT apply here: it closes the public pages, not an employee's switch.
-- Returns {enabled, token, created_at}; token and created_at are null when off.
create or replace function public.photo_share_set(p_actor uuid,p_album uuid,p_job uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare link public.photo_share_links;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if num_nonnulls(p_album,p_job)<>1 or p_enabled is null then raise exception 'invalid_input'; end if;
  -- One switch at a time per target, so two people pressing "on" together get one link, not an error.
  perform pg_advisory_xact_lock(hashtextextended('photo-share:'||coalesce(p_album,p_job)::text,0));
  select * into link from public.photo_share_links where revoked_at is null and ((p_album is not null and album_id=p_album) or (p_job is not null and job_id=p_job));
  if p_enabled then
    if p_album is not null and not exists(select 1 from public.albums where id=p_album and deleted_at is null) then raise exception 'not_found'; end if;
    if p_job is not null and not exists(select 1 from public.jobs where id=p_job and is_active) then raise exception 'not_found'; end if;
    if link.id is null then
      insert into public.photo_share_links(token,album_id,job_id,created_by)
        values(rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'='),p_album,p_job,p_actor) returning * into link;
    end if;
    return jsonb_build_object('enabled',true,'token',link.token,'created_at',link.created_at);
  end if;
  if link.id is not null then
    update public.photo_share_links set revoked_at=clock_timestamp(),revoked_by=p_actor where id=link.id;
  end if;
  return jsonb_build_object('enabled',false,'token',null,'created_at',null);
end $$;

-- What the share pop-up shows when it opens: whether this target's link is on, the link itself so
-- it can be shown again (Decision 12), and whether share pages are open at all, so the pop-up can
-- say when a link exists but nobody can open it yet. NEW. Signed-in employees only.
create or replace function public.photo_share_status(p_actor uuid,p_album uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare link public.photo_share_links; pages_open boolean;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if num_nonnulls(p_album,p_job)<>1 then raise exception 'invalid_input'; end if;
  if p_album is not null and not exists(select 1 from public.albums where id=p_album and deleted_at is null) then raise exception 'not_found'; end if;
  if p_job is not null and not exists(select 1 from public.jobs where id=p_job) then raise exception 'not_found'; end if;
  select * into link from public.photo_share_links where revoked_at is null and ((p_album is not null and album_id=p_album) or (p_job is not null and job_id=p_job));
  select coalesce(bool_or(sharing_enabled),false) into pages_open from public.photo_release_state where singleton and schema_generation=1;
  return jsonb_build_object('enabled',link.id is not null,'token',link.token,'created_at',link.created_at,'pages_open',pages_open);
end $$;

-- The public read. NEW. See THE SECURITY CONTRACT at the top of this file; each numbered point is
-- marked where it is kept. There is no actor: the visitor is not signed in. Only the service
-- role may call it, from the one public route.
--   p_token   the address's token. Nothing else selects what is read.                        [1]
--   p_after   null for the first page, else the previous answer's `next_after`.
--   p_limit   1-200 photos; anything else reads as 100.
-- Returns NULL for anything that is not a live link whose pages are open.                     [2]
-- Newest first by capture date, then id, the order the app uses, so paging is stable.
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
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'kind',q.kind,'captured_at',q.captured_at,'original_name',q.original_name,'mime_type',q.mime_type,
      'duration_secs',q.duration_secs,'original_path',q.original_path,'thumb_path',q.thumb_path,'preview_path',q.preview_path,'playback_path',q.playback_path)
      order by q.captured_at desc,q.id desc),'[]') into page
    from (select p.id,p.kind,p.captured_at,p.original_name,p.mime_type,p.duration_secs,p.original_path,p.thumb_path,p.preview_path,p.playback_path
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

-- Grants, by name. A rebuilt database starts from defaults that let clients execute everything.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_require_gate','photo_share_set','photo_share_status','photo_share_read') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
