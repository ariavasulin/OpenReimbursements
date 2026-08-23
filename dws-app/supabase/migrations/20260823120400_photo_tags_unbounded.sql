-- get_photo_tags: drop the cap.
--
-- Photo search builds its tags.ov.{…} predicate from this list, so a cap here
-- silently drops photos from search results; the only bound the search route
-- keeps is its own URL-length guard on that predicate.
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
