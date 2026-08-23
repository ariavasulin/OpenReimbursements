-- get_photo_tags: drop the cap.
--
-- The 10,000-row JS scan this RPC replaced collected every tag; the RPC
-- capped the distinct list at 500 (200 from photo search). Past the cap,
-- alphabetically late tags vanished from the Tags filter, and — because photo
-- search builds its tags.ov.{…} predicate from that list — photos carrying
-- them vanished from search results, in a normal-looking response. Neither
-- caller wants a cap, so the parameter goes with it.
--
-- The signature changes, so the old overload is dropped first (PostgREST
-- cannot choose between overloads when a caller omits defaulted arguments).

drop function if exists public.get_photo_tags(uuid, text, int);

create or replace function public.get_photo_tags(
  job_filter uuid default null,
  q          text default null
)
returns table (tag text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct t.tag
  from public.photos p
  cross join lateral unnest(p.tags) as t(tag)
  where (job_filter is null or p.job_id = job_filter)
    and (q is null or t.tag ilike '%' || q || '%')
  order by 1;
$$;

revoke all on function public.get_photo_tags(uuid, text) from public;
grant execute on function public.get_photo_tags(uuid, text) to authenticated;
