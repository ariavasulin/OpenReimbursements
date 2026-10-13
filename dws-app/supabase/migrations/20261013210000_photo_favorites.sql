-- Favorites (the owner's "heart each user can use").
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching app change. Additive only (one new
-- table, one new function), so the live app keeps working.
--
-- The model: a favorite is personal. photo_favorites holds (who, which photo); a person reads
-- only their own rows (the row rule below), so a grid embedding `favorites:photo_favorites(user_id)`
-- through the employee's session gets [] or [{user_id: me}] per photo and nobody else's hearts.
-- A favorite survives the photo's trip through Trash (restore brings it back) and goes with the
-- photo when it is deleted forever (the foreign key cascades).
begin;

create table if not exists public.photo_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid not null references public.photos(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, photo_id)
);
create index if not exists photo_favorites_photo on public.photo_favorites(photo_id);
alter table public.photo_favorites enable row level security;
revoke all on table public.photo_favorites from public,anon,authenticated;
grant select on table public.photo_favorites to authenticated;
grant all on table public.photo_favorites to service_role;
drop policy if exists photo_favorites_select on public.photo_favorites;
create policy photo_favorites_select on public.photo_favorites for select to authenticated using (user_id = auth.uid());

-- Favorite, or unfavorite, up to 500 photos for the actor. NEW. Only active photos can be
-- favorited (a trashed one is not offered anywhere); unfavoriting takes any id. A repeat is a
-- no-op. Returns how many of the named photos are the actor's favorites afterwards (p_on) or how
-- many favorites were removed (not p_on).
create or replace function public.photo_favorite(p_actor uuid,p_photo_ids uuid[],p_on boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  if p_photo_ids is null or cardinality(p_photo_ids) not between 1 and 500
    or exists(select 1 from unnest(p_photo_ids) x where x is null) then raise exception 'invalid_input'; end if;
  if p_on then
    insert into public.photo_favorites(user_id,photo_id)
      select p_actor,ph.id from public.photos ph where ph.id=any(p_photo_ids) and ph.deleted_at is null
      on conflict do nothing;
    select count(*) into n from public.photo_favorites f join public.photos ph on ph.id=f.photo_id
      where f.user_id=p_actor and f.photo_id=any(p_photo_ids) and ph.deleted_at is null;
  else
    delete from public.photo_favorites where user_id=p_actor and photo_id=any(p_photo_ids);
    get diagnostics n=row_count;
  end if;
  return jsonb_build_object('updated',n);
end $$;

-- Grants, by name.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_favorite') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
