-- Office jobs are named and numbered in the office database. A job with synced_at
-- set came from there (shop.refresh_jobs() every 15 minutes, or the manual
-- scripts/import-jobs.mjs), and the next refresh writes the office's name back over
-- any rename made in the app. A renumber made in the app left the office number free,
-- so the next refresh created a second, empty project under it. The app refuses
-- both, with job_office_managed.
--
-- photo_rename_job, from 20260923180000. CHANGED: an office job (synced_at set)
-- cannot be given a different name or number; sending its current name and number
-- back is still fine. UNCHANGED: every other line. create or replace keeps its grants.
create or replace function public.photo_rename_job(p_actor uuid,p_job_id uuid,p_name text,p_job_number text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.jobs; n text := public.photo_job_name(p_name); num text := nullif(btrim(coalesce(p_job_number,'')),'');
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into j from public.jobs where id=p_job_id and deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  -- Sending the current number back (a generated P- code included) keeps it;
  -- only a different number must obey the rule and be free.
  if num=j.job_number then num:=null; end if;
  if j.synced_at is not null and (num is not null or n is distinct from j.name) then
    raise exception 'job_office_managed';
  end if;
  if num is not null then num:=public.photo_job_number(num); perform public.photo_assert_job_number_free(num,j.id); end if;
  begin
    update public.jobs set name=n,job_number=coalesce(num,job_number) where id=p_job_id returning * into j;
  exception when unique_violation then raise exception 'job_number_taken';
  end;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'job_number',j.job_number,'name',j.name,'is_active',j.is_active));
end $$;
