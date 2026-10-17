-- Faster server reads for DWS Photos (performance round 1, server and database package:
-- audit findings DB-1, DB-10, DB-7, GRID-6, DB-2, DB-4, DB-5).
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching app change. Safe for the live app in
-- between: everything here is NEW (four functions, one view, one index) or keeps its shape (one row
-- rule rewritten to an equivalent form, one page function re-created with the same parameters and
-- result). The live app's album list keeps working: its rows only gain three keys it ignores.
-- Apply with `supabase db query -f` like any transactional file (no CONCURRENTLY; see the index note).
--
-- WHAT CHANGES, item by item:
--   1. photo_actor_context(p_actor)                      NEW  (DB-1)
--   2. get_photo_me()                                    NEW  (DB-5)
--   3. get_photo_album_cards(q)                          NEW  (DB-10, DB-7, GRID-6)
--   4. get_photo_album_summaries(q)                      CHANGED body only, same columns (DB-10)
--   5. get_photo_album_summaries_by_name_page(...)       CHANGED: reads get_photo_album_cards
--   6. photo_favorite_photos view                        NEW  (DB-2)
--   7. photo_favorites_select row rule                   CHANGED to the (select auth.uid()) form (DB-2)
--   8. photos_active_job_created index                   NEW  (DB-4)
-- Grants are restated by name at the end.
begin;

-- 1. Everything requirePhotoActor checks after Auth has verified the cookie, in ONE round trip
-- instead of three back to back (the profile, photo_require_actor, the release gates). The route
-- still decides, in the same order as before: no live employee/admin profile is `forbidden`; a
-- deleted or banned Auth user (photo_require_actor's own test, word for word) is `unauthenticated`;
-- a closed gate is `temporarily_unavailable`. Service-only, like photo_require_actor; it only reads.
create or replace function public.photo_actor_context(p_actor uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'has_profile', p.user_id is not null,
    'role', p.role,
    'profile_deleted', p.deleted_at is not null,
    'photo_admin', coalesce(p.photo_admin, false),
    'active', p_actor is not null and exists(select 1 from public.user_profiles p2 join auth.users u on u.id=p2.user_id
      where p2.user_id=p_actor and p2.deleted_at is null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())),
    'schema_generation', r.schema_generation,
    'photo_writes_enabled', r.photo_writes_enabled,
    'mcp_enabled', r.mcp_enabled,
    'repair_enabled', r.repair_enabled)
  from (select 1) one
  left join public.user_profiles p on p.user_id=p_actor
  left join public.photo_release_state r on r.singleton;
$$;

-- 2. The signed-in person's own photo permissions and settings, for GET /api/photos/me (and the
-- older /actor and /settings reads). Who is asking comes from the verified token (auth.uid()), never
-- from the request, so the route needs no separate call to the Auth server. Answers null for no
-- user, an anonymous token, or an Auth user that is deleted or banned (the route says 401, as the
-- Auth server's getUser did). photo_admin is false for a deactivated profile, as before.
-- SECURITY DEFINER only to read auth.users; every read is pinned to auth.uid().
create or replace function public.get_photo_me()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select case when me.id is null
      or coalesce(auth.jwt()->>'is_anonymous','false')='true'
      or not exists(select 1 from auth.users u where u.id=me.id and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
    then null
    else jsonb_build_object(
      'user_id', me.id,
      'photo_admin', coalesce(p.photo_admin, false) and p.deleted_at is null,
      'slideshow_shuffle', coalesce(p.slideshow_shuffle, false),
      'slideshow_delay_seconds', p.slideshow_delay_seconds,
      'starter_tags', coalesce((select s.starter_tags from public.photo_settings s where s.singleton), '{}'::text[]))
    end
  from (select auth.uid() as id) me
  left join public.user_profiles p on p.user_id=me.id;
$$;

-- 3. Album cards: get_photo_album_summaries' columns plus what the app used to fetch separately.
-- NEW rather than a changed get_photo_album_summaries, because changing a function's columns means
-- drop-and-create, and an earlier migration's `create or replace` of the old shape would then fail
-- on a replay. Added columns:
--   created_by        who made it (DB-7: the list route made a second query for this)
--   sort_mode         'date' or 'custom' (GRID-6: an album page can start its photo list at once)
--   has_custom_order  an arranged order is saved (the album header route's same-named field)
-- The work (DB-10): ONE pass per album over album_photos joined to photos, where there were two
-- (one for the count and latest date, one for the 4 cover thumbs); the album_photos row rule adds a
-- photos lookup per membership on each pass, so this halves the lookups. Cover thumbs stay newest
-- first by created_at (id breaks a tie). SECURITY INVOKER, as before: an employee's call keeps the
-- row rules on albums, album_photos and photos; the active-only filters stay explicit so a
-- service-role caller gets the same answer.
create or replace function public.get_photo_album_cards(q text default null)
returns table (
  id               uuid,
  name             text,
  photo_count      bigint,
  latest_added     timestamptz,
  thumbs           text[],
  created_at       timestamptz,
  created_by       uuid,
  sort_mode        text,
  has_custom_order boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.id,
    a.name,
    s.photo_count,
    s.latest_added,
    coalesce(s.thumbs, '{}'::text[]) as thumbs,
    a.created_at,
    a.created_by,
    a.sort_mode,
    coalesce(s.has_custom_order, false) as has_custom_order
  from public.albums a
  cross join lateral (
    select count(*) as photo_count,
      max(ap.added_at) as latest_added,
      (array_agg(p.thumb_path order by p.created_at desc, p.id desc) filter (where p.thumb_path is not null))[1:4] as thumbs,
      bool_or(ap.position is not null) as has_custom_order
    from public.album_photos ap
    join public.photos p on p.id = ap.photo_id
    where ap.album_id = a.id and p.deleted_at is null
  ) s
  where a.deleted_at is null
    and (q is null or a.name ilike '%' || q || '%')
  -- Most recently added-to first; an empty album sorts by when it was made.
  order by coalesce(s.latest_added, a.created_at) desc, a.id;
$$;

-- 4. get_photo_album_summaries, from 20260921024651. CHANGED: the body reads get_photo_album_cards,
-- so its remaining caller (the older get_photo_album_summaries_page) gets the one-pass read too.
-- UNCHANGED: the parameters, the six columns and their order, the row order.
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
  select c.id, c.name, c.photo_count, c.latest_added, c.thumbs, c.created_at
  from public.get_photo_album_cards(q) c;
$$;

-- 5. get_photo_album_summaries_by_name_page, from 20261014120000 (what GET /api/photo-albums calls).
-- CHANGED: one line, `from public.get_photo_album_cards(q) s` (was get_photo_album_summaries), so
-- each row also carries created_by, sort_mode and has_custom_order. UNCHANGED: every other line.
create or replace function public.get_photo_album_summaries_by_name_page(
  q text default null, p_limit integer default 200,
  p_after_name text default null, p_after_id uuid default null
)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 or (p_after_name is null)<>(p_after_id is null) then
    raise exception 'invalid_input';
  end if;
  with summaries as (
    select s.*,public.photo_sort_key(s.name) as name_key
    from public.get_photo_album_cards(q) s
  ), candidates as (
    select s.*,row_number() over(order by s.name_key collate "C",s.id) as position
    from summaries s
    where p_after_id is null or s.name_key collate "C">p_after_name collate "C"
      or (s.name_key=p_after_name and s.id>p_after_id)
    order by s.name_key collate "C",s.id
    limit p_limit+1
  )
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(to_jsonb(c)-'position'-'name_key' order by position) filter(where position<=p_limit),'[]'::jsonb),
    'next_cursor',case when count(*)>p_limit then
      (jsonb_agg(jsonb_build_object('name',c.name_key,'id',c.id) order by position)
        filter(where position<=p_limit))->(p_limit-1) else null end
  ) into result from candidates c;
  return result;
end $$;

-- 6. The reader's own favorite photos. NEW. GET /api/photos (and /ids) read Favorites from here,
-- so Postgres starts from the reader's favorites (a handful of rows, by primary key) instead of
-- walking the whole library newest first and checking each photo for a favorite (DB-2).
-- SECURITY INVOKER: the photos row rule still applies, and the user filter is the same as the
-- photo_favorites row rule. Like album_photo_order, the view freezes `p.*` when it is made: a
-- later column on photos must be added to both views (at the end, by `create or replace`).
create or replace view public.photo_favorite_photos with (security_invoker=true) as
  select p.*
  from public.photo_favorites f
  join public.photos p on p.id=f.photo_id
  where f.user_id=(select auth.uid());

-- 7. photo_favorites_select, from 20261013210000. CHANGED: `(select auth.uid())`, which Postgres
-- evaluates once per query instead of once per row. Same rows visible.
drop policy if exists photo_favorites_select on public.photo_favorites;
create policy photo_favorites_select on public.photo_favorites for select to authenticated using (user_id = (select auth.uid()));

-- 8. The Projects list counts each project's active photos and takes its 4 newest thumbnails
-- (get_photo_job_summaries); this index answers both from the index alone (DB-4). Not CONCURRENTLY,
-- so it can ride in this transaction: on today's ~2,000-photo table the build holds writes to photos
-- for well under a second. If the table has grown past ~100k rows when this is applied, run this one
-- statement on its own with CONCURRENTLY instead (see supabase/migrations/README.md).
create index if not exists photos_active_job_created
  on public.photos (job_id, created_at desc) include (thumb_path) where deleted_at is null;

-- Grants, by name.
revoke all on function public.photo_actor_context(uuid) from public,anon,authenticated;
grant execute on function public.photo_actor_context(uuid) to service_role;
revoke all on function public.get_photo_me() from public,anon;
grant execute on function public.get_photo_me() to authenticated,service_role;
revoke all on function public.get_photo_album_cards(text) from public,anon;
grant execute on function public.get_photo_album_cards(text) to authenticated,service_role;
revoke all on function public.get_photo_album_summaries(text) from public,anon;
grant execute on function public.get_photo_album_summaries(text) to authenticated,service_role;
revoke all on function public.get_photo_album_summaries_by_name_page(text,integer,text,uuid) from public,anon;
grant execute on function public.get_photo_album_summaries_by_name_page(text,integer,text,uuid) to authenticated,service_role;
revoke all on table public.photo_favorite_photos from public,anon,authenticated;
grant select on table public.photo_favorite_photos to authenticated,service_role;
commit;
