-- Projects by job number, albums by name (the owner's round-three notes).
--
-- WHEN TO APPLY: BEFORE the deploy that ships the matching routes. Additive only:
-- two NEW page functions and one helper. The two functions the live app calls today
-- (get_photo_job_summaries_page, get_photo_album_summaries_page, ordered by recent
-- activity) are left in place until the app no longer calls them.
--
-- Projects: job number descending, so the newest job is on top. All-digit numbers
-- compare as numbers ('3612' above '399'). Projects with a generated P-<n> code, and
-- any other non-numeric number, come after every numbered project, newest code first.
-- Albums: name A to Z, ignoring case; a number inside a name compares as a number
-- ('Kitchen 2' before 'Kitchen 10'), and names that start with a digit come before
-- letters. An id breaks every tie, so keyset paging is exact.
begin;

-- A sort key for a name: lowercase, every digit run zero-padded to 12 places, so
-- '2' < '10' and digits sort before letters under the C collation the callers use.
create or replace function public.photo_sort_key(p_name text)
returns text language sql immutable set search_path=public,pg_temp as $$
  select coalesce(string_agg(case when m[1] ~ '^[0-9]+$' then lpad(m[1],12,'0') else m[1] end,'' order by ord),'')
  from regexp_matches(lower(coalesce(p_name,'')),'([0-9]+|[^0-9]+)','g') with ordinality as t(m,ord);
$$;

-- The project key: '1' + zero-padded number for all-digit job numbers, '0' + the
-- padded code number for P-<n>, '0' + the text otherwise. Descending: numbered first.
create or replace function public.photo_job_number_key(p_job_number text)
returns text language sql immutable set search_path=public,pg_temp as $$
  select case when p_job_number ~ '^[0-9]+$' then '1'||lpad(p_job_number,20,'0')
    when p_job_number ~ '^P-[0-9]+$' then '0'||lpad(substr(p_job_number,3),20,'0')
    else '0'||coalesce(p_job_number,'') end;
$$;

create or replace function public.get_photo_job_summaries_by_number_page(
  search_query text default null, p_limit integer default 200,
  p_after_number text default null, p_after_id uuid default null
)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 or (p_after_number is null)<>(p_after_id is null) then
    raise exception 'invalid_input';
  end if;
  with summaries as (
    select s.*,public.photo_job_number_key(s.job_number) as number_key
    from public.get_photo_job_summaries(search_query) s
  ), candidates as (
    select s.*,row_number() over(order by s.number_key collate "C" desc,s.id) as position
    from summaries s
    where p_after_id is null or s.number_key collate "C"<p_after_number collate "C"
      or (s.number_key=p_after_number and s.id>p_after_id)
    order by s.number_key collate "C" desc,s.id
    limit p_limit+1
  )
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(to_jsonb(c)-'position'-'number_key' order by position) filter(where position<=p_limit),'[]'::jsonb),
    'next_cursor',case when count(*)>p_limit then
      (jsonb_agg(jsonb_build_object('number',c.number_key,'id',c.id) order by position)
        filter(where position<=p_limit))->(p_limit-1) else null end
  ) into result from candidates c;
  return result;
end $$;

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
    from public.get_photo_album_summaries(q) s
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

revoke all on function public.photo_sort_key(text) from public,anon;
revoke all on function public.photo_job_number_key(text) from public,anon;
revoke all on function public.get_photo_job_summaries_by_number_page(text,integer,text,uuid) from public,anon;
revoke all on function public.get_photo_album_summaries_by_name_page(text,integer,text,uuid) from public,anon;
grant execute on function public.photo_sort_key(text) to authenticated,service_role;
grant execute on function public.photo_job_number_key(text) to authenticated,service_role;
grant execute on function public.get_photo_job_summaries_by_number_page(text,integer,text,uuid) to authenticated,service_role;
grant execute on function public.get_photo_album_summaries_by_name_page(text,integer,text,uuid) to authenticated,service_role;
commit;
