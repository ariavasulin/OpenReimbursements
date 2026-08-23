-- security invoker keeps RLS in force; the photos_select policy is
-- `to authenticated using (true)`, so a signed-in caller sees the same rows it
-- does today.
create or replace function public.get_photo_job_summaries(search_query text default null)
returns table (
  id            uuid,
  job_number    text,
  name          text,
  location      text,
  photo_count   bigint,
  latest_upload timestamptz,
  thumbs        text[]
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    j.id,
    j.job_number,
    j.name,
    j.location,
    coalesce(a.photo_count, 0) as photo_count,
    a.latest_upload,
    coalesce(t.thumbs, '{}'::text[]) as thumbs
  from public.jobs j
  left join lateral (
    select count(*) as photo_count, max(p.created_at) as latest_upload
    from public.photos p
    where p.job_id = j.id
  ) a on true
  left join lateral (
    select array_agg(x.thumb_path order by x.created_at desc) as thumbs
    from (
      select p2.thumb_path, p2.created_at
      from public.photos p2
      where p2.job_id = j.id and p2.thumb_path is not null
      order by p2.created_at desc
      limit 4
    ) x
  ) t on true
  where j.is_active
    and (
      search_query is null
      or j.job_number ilike '%' || search_query || '%'
      or j.name       ilike '%' || search_query || '%'
    )
  -- Tiebreaker for jobs with no photos. The JS this replaces used
  -- localeCompare(..., { numeric: true }), which orders '100' above '99';
  -- a plain text sort would invert that as soon as job numbers differ in
  -- length. Zero-pad all-digit job numbers so the SQL sort matches.
  order by a.latest_upload desc nulls last,
           (case when j.job_number ~ '^[0-9]+$'
                 then lpad(j.job_number, 20, '0')
                 else j.job_number end) desc;
$$;

revoke all on function public.get_photo_job_summaries(text) from public;
grant execute on function public.get_photo_job_summaries(text) to authenticated;

create or replace function public.get_photo_tags(
  job_filter uuid default null,
  q          text default null,
  max_tags   int  default 500
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
  order by 1
  limit greatest(max_tags, 1);
$$;

revoke all on function public.get_photo_tags(uuid, text, int) from public;
grant execute on function public.get_photo_tags(uuid, text, int) to authenticated;
