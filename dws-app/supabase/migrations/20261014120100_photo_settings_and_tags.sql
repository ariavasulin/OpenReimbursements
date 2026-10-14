-- Default tags an admin can edit, a per-account slideshow setting, and the tag
-- rename the owner asked for (round-three notes).
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching screens. The rename
-- below changes photo data at once: every photo tagged "professional" becomes
-- "Photoshoot", and the lowercase "shop" / "field" (and the old starter names
-- "shop drawing" / "field dimension") become "Shop" / "Field". The live app keeps
-- working on the renamed tags; only its three hard-coded starter tags are stale
-- until the deploy.
--
-- WHAT CHANGES:
--   * photo_settings: one row of app-wide settings. starter_tags is the list every
--     tag picker offers before any photo carries them (it replaces the STARTER_TAGS
--     constant in src/lib/photos/tags.ts). Anyone signed in may read it; only a photo
--     admin may change it, through photo_set_starter_tags.
--   * user_profiles.slideshow_shuffle and slideshow_delay_seconds: each person's own
--     slideshow setting, changed through photo_set_slideshow.
--   * The tag rename on photos (trashed ones included, so a restore shows the new
--     name) and on the tag choices of any import still in draft.
begin;

create table if not exists public.photo_settings (
  singleton boolean primary key default true check (singleton),
  starter_tags text[] not null default '{Shop,Field,Photoshoot}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.user_profiles(user_id)
);
comment on table public.photo_settings is 'DWS Photos app-wide settings: one row. starter_tags: the default tags every tag picker offers.';
insert into public.photo_settings(singleton) values (true) on conflict do nothing;
alter table public.photo_settings enable row level security;
revoke all on table public.photo_settings from public,anon,authenticated;
grant select on table public.photo_settings to authenticated;
grant all on table public.photo_settings to service_role;
drop policy if exists photo_settings_select on public.photo_settings;
create policy photo_settings_select on public.photo_settings for select to authenticated using (true);

-- Replace the default tags. NEW. Photo admins only. Up to 20 tags, each 1-64
-- characters, one spelling each ignoring case (photo_clean_tags); an empty list is
-- allowed and means the pickers offer only tags in use.
create or replace function public.photo_set_starter_tags(p_actor uuid,p_tags text[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare cleaned text[];
begin
  perform public.photo_require_actor(p_actor);
  if not public.photo_actor_is_admin(p_actor) then raise exception 'forbidden'; end if;
  if p_tags is null then raise exception 'invalid_input'; end if;
  cleaned:=public.photo_clean_tags(p_tags);
  update public.photo_settings set starter_tags=cleaned,updated_at=clock_timestamp(),updated_by=p_actor where singleton;
  return jsonb_build_object('starter_tags',cleaned);
end $$;

alter table public.user_profiles add column if not exists slideshow_shuffle boolean not null default false;
alter table public.user_profiles add column if not exists slideshow_delay_seconds integer not null default 4
  check (slideshow_delay_seconds between 1 and 60);
comment on column public.user_profiles.slideshow_shuffle is 'DWS Photos: this person''s slideshow plays in random order.';
comment on column public.user_profiles.slideshow_delay_seconds is 'DWS Photos: seconds each slideshow photo stays on screen for this person.';

-- Set the caller's own slideshow setting. NEW. Either value may be omitted (null)
-- to keep what it was.
create or replace function public.photo_set_slideshow(p_actor uuid,p_shuffle boolean,p_delay_seconds integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.user_profiles;
begin
  perform public.photo_require_actor(p_actor);
  if p_delay_seconds is not null and p_delay_seconds not between 1 and 60 then raise exception 'invalid_input'; end if;
  update public.user_profiles set slideshow_shuffle=coalesce(p_shuffle,slideshow_shuffle),
    slideshow_delay_seconds=coalesce(p_delay_seconds,slideshow_delay_seconds),updated_at=clock_timestamp()
    where user_id=p_actor returning * into u;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('shuffle',u.slideshow_shuffle,'delay_seconds',u.slideshow_delay_seconds);
end $$;

-- Grants, by name.
do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('photo_set_starter_tags','photo_set_slideshow') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;

-- The rename. Runs as the migration operator, so photo_guard_direct_write lets it
-- through (it only checks client roles). Each tag is mapped, then the list is
-- de-duplicated ignoring case keeping the first position, as photo_clean_tags does.
create or replace function pg_temp.renamed_tags(p_tags text[]) returns text[] language sql immutable as $$
  select coalesce(array_agg(d.tag order by d.ord),'{}') from (
    select distinct on (lower(x.tag)) x.tag,x.ord from (
      select case lower(u.tag)
        when 'professional' then 'Photoshoot'
        when 'shop drawing' then 'Shop' when 'shop' then 'Shop'
        when 'field dimension' then 'Field' when 'field' then 'Field'
        else u.tag end as tag,u.ord
      from unnest(p_tags) with ordinality u(tag,ord)) x
    order by lower(x.tag),x.ord) d;
$$;
update public.photos p set tags=pg_temp.renamed_tags(p.tags)
  where exists(select 1 from unnest(p.tags) t where lower(t) in ('professional','shop drawing','shop','field dimension','field'))
    and p.tags is distinct from pg_temp.renamed_tags(p.tags);
update public.migration_folders f set tags=pg_temp.renamed_tags(f.tags),updated_at=clock_timestamp()
  from public.migration_sources s join public.migration_batches b on b.id=s.batch_id
  where s.id=f.source_id and b.status='draft'
    and exists(select 1 from unnest(f.tags) t where lower(t) in ('professional','shop drawing','shop','field dimension','field'))
    and f.tags is distinct from pg_temp.renamed_tags(f.tags);
commit;
