-- Hand-made photo projects. Until the office project database is bridged, any
-- photo actor may create a job or rename one. job_number stays unique and
-- non-null because every caller addresses a job by it: a project created
-- without an office number receives a generated P-<n> code, which cannot
-- collide with the office's numeric job numbers.
begin;
alter table public.jobs add column if not exists created_by uuid references public.user_profiles(user_id);
alter table public.jobs add column if not exists created_at timestamptz default now();
create sequence if not exists public.job_project_code_seq;
revoke all on sequence public.job_project_code_seq from public,anon,authenticated;

create or replace function public.photo_job_name(p_name text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare n text := btrim(regexp_replace(coalesce(p_name,''),'\s+',' ','g'));
begin
  if char_length(n) not between 1 and 120 then raise exception 'invalid_input'; end if;
  return n;
end $$;

create or replace function public.photo_create_job(p_actor uuid,p_name text,p_job_number text default null,p_location text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; n text := public.photo_job_name(p_name);
  num text := nullif(btrim(coalesce(p_job_number,'')),''); loc text := nullif(btrim(coalesce(p_location,'')),'');
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  -- The P- namespace belongs to the sequence, so a typed code cannot squat on a future one.
  if char_length(num)>32 or char_length(loc)>200 or num ~* '^P-' then raise exception 'invalid_input'; end if;
  if num is not null then
    select * into j from public.jobs where job_number=num;
    if found then return jsonb_build_object('status','exists','job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active)); end if;
  end if;
  insert into public.jobs(job_number,name,location,is_active,synced_at,created_by)
  values(coalesce(num,'P-'||nextval('public.job_project_code_seq')),n,loc,true,null,p_actor)
  on conflict(job_number) do nothing returning * into j;
  -- A concurrent create of the same typed number won the insert; report its row.
  if not found then select * into j from public.jobs where job_number=num;
    return jsonb_build_object('status','exists','job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active)); end if;
  return jsonb_build_object('status','created','job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active));
end $$;

create or replace function public.photo_rename_job(p_actor uuid,p_job_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; n text := public.photo_job_name(p_name);
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  update public.jobs set name=n where id=p_job_id returning * into j;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active));
end $$;

revoke all on function public.photo_job_name(text) from public,anon,authenticated;
revoke all on function public.photo_create_job(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.photo_rename_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.photo_job_name(text) to service_role;
grant execute on function public.photo_create_job(uuid,text,text,text) to service_role;
grant execute on function public.photo_rename_job(uuid,uuid,text) to service_role;
commit;
