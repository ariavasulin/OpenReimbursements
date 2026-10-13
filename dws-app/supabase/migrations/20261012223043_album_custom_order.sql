-- Album custom order
-- (plans/active/dws-photos-client-feedback/plan.md, Phase W2-E; Decision 9; AC-16).
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching app change. Additive only (a nullable
-- column, a column with a default, a new function, a new trigger, a new view; photo_share_read keeps
-- its parameters and its date order), so the live app keeps working.
--
-- The model: album_photos.position holds an album's hand-made order (1..n after an Arrange), and
-- albums.sort_mode says whether the album currently shows it ('custom') or newest first ('date').
-- Going back to 'date' keeps the positions, so choosing Custom again restores the same order.
-- Wherever an album is read in custom order the key is (position, photo id), ascending, with a
-- photo that has no position (added while the album was in date order) after every one that has.
--
-- WHAT CHANGES, function by function, is listed above each one. The one re-created function starts
-- from its latest definition and changes only the named lines. Grants are restated by name at the end.
begin;

alter table public.album_photos add column if not exists position double precision;
alter table public.albums add column if not exists sort_mode text not null default 'date';
do $$ begin
  if not exists(select 1 from pg_constraint where conname='albums_sort_mode_check' and conrelid='public.albums'::regclass) then
    alter table public.albums add constraint albums_sort_mode_check check (sort_mode in ('date','custom'));
  end if;
end $$;

-- Save an album's order, or put it back in date order. NEW. Any signed-in employee may arrange any
-- album, as they may rename it (the plan's Decision 2 keeps album organizing open to everyone).
--   * p_photo_ids, 1-2,000 ids (Decision 9's arranging cap), must be exactly the album's active
--     members, each once; anything else is invalid_input. They get positions 1..n in that order and
--     the album becomes 'custom'. Trashed members follow, in their previous order, so a photo restored
--     from Trash comes back at the end.
--   * p_photo_ids null sets 'date' and keeps every position, so the next switch back restores them.
-- The album row is locked for update, so an add or remove (which hold it for share) waits.
create or replace function public.photo_album_reorder(p_actor uuid,p_album uuid,p_photo_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.albums; n integer;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_photo_ids is not null and cardinality(p_photo_ids) not between 1 and 2000 then raise exception 'invalid_input'; end if;
  select * into a from public.albums where id=p_album and deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  if p_photo_ids is null then
    update public.albums set sort_mode='date',updated_at=clock_timestamp() where id=p_album and sort_mode<>'date';
    return jsonb_build_object('sort_mode','date');
  end if;
  n:=cardinality(p_photo_ids);
  if exists(select 1 from unnest(p_photo_ids) x where x is null)
    or (select count(distinct x) from unnest(p_photo_ids) x)<>n
    or (select count(*) from public.album_photos ap join public.photos ph on ph.id=ap.photo_id
          where ap.album_id=p_album and ph.deleted_at is null)<>n
    or exists(select 1 from unnest(p_photo_ids) x where not exists(
          select 1 from public.album_photos ap join public.photos ph on ph.id=ap.photo_id
          where ap.album_id=p_album and ap.photo_id=x and ph.deleted_at is null)) then
    raise exception 'invalid_input';
  end if;
  update public.album_photos ap set position=o.ord from unnest(p_photo_ids) with ordinality o(photo_id,ord)
    where ap.album_id=p_album and ap.photo_id=o.photo_id;
  -- Every member the list did not name (the trashed ones at validation time, plus any restored since)
  -- goes after the arranged photos, so a photo coming back from Trash lands last rather than on a
  -- position the list just assigned.
  update public.album_photos ap set position=n+t.ord from (
      select ap2.photo_id,row_number() over(order by ap2.position nulls last,ap2.added_at,ap2.photo_id) as ord
      from public.album_photos ap2
      where ap2.album_id=p_album and ap2.photo_id<>all(p_photo_ids)) t
    where ap.album_id=p_album and ap.photo_id=t.photo_id;
  update public.albums set sort_mode='custom',updated_at=clock_timestamp() where id=p_album;
  return jsonb_build_object('sort_mode','custom','arranged',n);
end $$;

-- A photo joining an album in custom order lands last. NEW, internal. A trigger rather than a change
-- to photo_album_add, because photos also join albums through an upload into the album
-- (photo_finalize_upload, photo_same_photo_outcome) and the folder import; every one of those paths
-- appends the same way. An album in date order leaves the position empty.
create or replace function public.photo_album_append_position()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.position is null and exists(select 1 from public.albums where id=new.album_id and sort_mode='custom') then
    -- Two photos joining at once would otherwise both read the same max. An advisory lock keyed on
    -- the album serializes them without touching the row locks photo_album_add already holds.
    perform pg_advisory_xact_lock(hashtext('album_position:'||new.album_id::text));
    select coalesce(max(ap.position),0)+1 into new.position from public.album_photos ap where ap.album_id=new.album_id;
  end if;
  return new;
end $$;
drop trigger if exists album_photos_append_position on public.album_photos;
create trigger album_photos_append_position before insert on public.album_photos
  for each row execute function public.photo_album_append_position();

-- An album's active photos with their place in its custom order. NEW. Read by GET /api/photos (and
-- /ids) for `album=…&sort=custom`, which filter it exactly as they filter photos. SECURITY INVOKER,
-- so an employee's read keeps the row rules of photos, album_photos, and albums (a deleted album
-- lists nothing). album_position is +Infinity for a photo with no position, so it sorts after every
-- positioned one and the keyset (album_position, id) never meets a null. The album columns come
-- first so a later column on photos can be added at the end by `create or replace`.
create or replace view public.album_photo_order with (security_invoker=true) as
  select ap.album_id,coalesce(ap.position,'Infinity'::double precision) as album_position,p.*
  from public.album_photos ap
  join public.photos p on p.id=ap.photo_id
  join public.albums a on a.id=ap.album_id and a.deleted_at is null;
revoke all on table public.album_photo_order from public,anon,authenticated;
grant select on table public.album_photo_order to authenticated,service_role;

-- photo_share_read, from 20261012182343. CHANGED: an album in custom order is read in that order,
-- (position, id) ascending, positionless photos last; its cursor is {position, id} instead of
-- {captured_at, id}, and a cursor of the other shape reads as nothing, as any foreign cursor does.
-- The changed lines: the declare line (custom, after_pos, last_pos), the album's name lookup (also
-- reads sort_mode), the cursor check and parse, the page select (aggregate order, the max position,
-- the position join, one keyset line, the inner order), and next_after. UNCHANGED: every other line,
-- the project branch, the count, and the column list (the privacy boundary).
create or replace function public.photo_share_read(p_token text,p_after jsonb default null,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare link public.photo_share_links; target_name text; total bigint; page jsonb; size integer; after_at timestamptz; after_id uuid; last jsonb;
  custom boolean := false; after_pos double precision; last_pos double precision;
begin
  -- [2] A closed gate is answered exactly like an unknown token. Read the switch directly, not
  -- through photo_require_gate: that raises, and an exception is a different answer.
  if not exists(select 1 from public.photo_release_state where singleton and schema_generation=1 and sharing_enabled) then return null; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
  select * into link from public.photo_share_links where token=p_token and revoked_at is null;
  if not found then return null; end if;
  -- [1][3] From here on the ONLY target is the one on the link's own row.
  if link.album_id is not null then
    select name,sort_mode='custom' into target_name,custom from public.albums where id=link.album_id and deleted_at is null;
  else
    select name into target_name from public.jobs where id=link.job_id and is_active;
  end if;
  if target_name is null then return null; end if;
  size:=case when p_limit between 1 and 200 then p_limit else 100 end;
  -- A cursor is either absent or exactly what this function handed out: an object holding both
  -- keys. Anything else -- a bare string or number, an empty object, half a cursor, values that do
  -- not parse -- is a cursor this function did not make, and reads as nothing rather than as page one.
  -- A custom-order album hands out {position, id}; everything else {captured_at, id}.
  if p_after is not null and jsonb_typeof(p_after)<>'null' then
    if jsonb_typeof(p_after)<>'object' or p_after->>(case when custom then 'position' else 'captured_at' end) is null or p_after->>'id' is null then return null; end if;
    begin
      if custom then after_pos:=(p_after->>'position')::double precision; else after_at:=(p_after->>'captured_at')::timestamptz; end if;
      after_id:=(p_after->>'id')::uuid;
    exception when others then return null;
    end;
  end if;
  -- [3] Membership for an album, project for a project; active photos only; images and videos only. [4]
  select count(*) into total from public.photos p
    where p.deleted_at is null and p.kind in ('image','video')
      and case when link.album_id is not null then exists(select 1 from public.album_photos ap where ap.album_id=link.album_id and ap.photo_id=p.id)
               else p.job_id=link.job_id end;
  -- [4] The column list below IS the privacy boundary. Add nothing to it without reading point 4.
  -- q.pos only orders the page and makes its cursor; it is not in the list.
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'kind',q.kind,'captured_at',q.captured_at,'original_name',q.original_name,'display_name',q.display_name,'mime_type',q.mime_type,
      'duration_secs',q.duration_secs,'original_path',q.original_path,'thumb_path',q.thumb_path,'preview_path',q.preview_path,'playback_path',q.playback_path)
      order by q.pos,case when custom then q.id end,q.captured_at desc,q.id desc),'[]'),max(q.pos) into page,last_pos
    from (select p.id,p.kind,p.captured_at,p.original_name,p.display_name,p.mime_type,p.duration_secs,p.original_path,p.thumb_path,p.preview_path,p.playback_path,o.pos
      from public.photos p
      left join lateral (select coalesce(ap.position,'Infinity'::double precision) as pos from public.album_photos ap
        where custom and ap.album_id=link.album_id and ap.photo_id=p.id) o on true
      where p.deleted_at is null and p.kind in ('image','video')
        and case when link.album_id is not null then exists(select 1 from public.album_photos ap where ap.album_id=link.album_id and ap.photo_id=p.id)
                 else p.job_id=link.job_id end
        and (after_at is null or (p.captured_at,p.id)<(after_at,after_id))
        and (after_pos is null or (o.pos,p.id)>(after_pos,after_id))
      order by o.pos,case when custom then p.id end,p.captured_at desc,p.id desc limit size) q;
  last:=page->(jsonb_array_length(page)-1);
  return jsonb_build_object('kind',case when link.album_id is not null then 'album' else 'project' end,'name',target_name,'count',total,'photos',page,
    'next_after',case when jsonb_array_length(page)=size then case when custom then jsonb_build_object('position',last_pos,'id',last->>'id')
      else jsonb_build_object('captured_at',last->>'captured_at','id',last->>'id') end end);
end $$;

-- Grants, by name.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_album_reorder','photo_share_read') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
  -- Internal: only the trigger calls it.
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_album_append_position') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $$;
commit;
