-- Additive operator tooling only: no activation, cleanup, grant change or index
-- retirement occurs when this migration is applied (including reapplication).
begin;
create table if not exists public.photo_cutover_epoch (
  singleton boolean primary key default true check(singleton), generation bigint not null default 0
);
insert into public.photo_cutover_epoch(singleton) values(true) on conflict do nothing;
create table if not exists public.photo_cutover_runs (
  id uuid primary key default gen_random_uuid(), mapping jsonb not null,
  mapping_digest text not null, generation bigint not null,
  status text not null default 'cleaning' check(status in ('cleaning','indexed','rolling_back','rolled_back')),
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists photo_cutover_mapping_active on public.photo_cutover_runs(mapping_digest) where status<>'rolled_back';
create table if not exists public.photo_cutover_groups (
  run_id uuid not null references public.photo_cutover_runs(id), digest text not null,
  choice jsonb not null, before_rows jsonb not null, after_rows jsonb not null,
  applied_at timestamptz not null, rolled_back_at timestamptz,
  primary key(run_id,digest)
);
do $$ declare t text; begin
  foreach t in array array['photo_cutover_epoch','photo_cutover_runs','photo_cutover_groups'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

-- Observe writes and deletion authorization, including process death before a
-- purge can remove its row. Permanent Phase 5 fences are never reset/removed.
create or replace function public.photo_cutover_observe_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if current_setting('dws.cutover_mutation',true) is distinct from 'yes'
    and exists(select 1 from public.photo_cutover_runs where status<>'rolled_back') then
    update public.photo_cutover_epoch set generation=generation+1 where singleton;
  end if;
  return null;
end $$;
drop trigger if exists photo_cutover_observe_write on public.photos;
create trigger photo_cutover_observe_write after insert or update or delete on public.photos
  for each statement execute function public.photo_cutover_observe_write();
drop trigger if exists photo_cutover_observe_write on public.photo_repair_deleted_paths;
create trigger photo_cutover_observe_write after insert on public.photo_repair_deleted_paths
  for each statement execute function public.photo_cutover_observe_write();
drop trigger if exists photo_cutover_observe_write on public.photo_repair_retired_ids;
create trigger photo_cutover_observe_write after insert on public.photo_repair_retired_ids
  for each statement execute function public.photo_cutover_observe_write();

create or replace function public.photo_cutover_hash(p_value jsonb)
returns text language sql immutable set search_path=public,extensions,pg_temp as $$
  select encode(digest(p_value::text,'sha256'),'hex');
$$;
create or replace function public.photo_cutover_snapshot(p_digest text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('digest',p_digest,'rows',r,'expected_before_image_digest',public.photo_cutover_hash(r))
  from (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') r from public.photos p
    where p.content_sha256=p_digest or p.legacy_content_sha256=p_digest) s;
$$;
create or replace function public.photo_cutover_require_closed()
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.photo_release_state where singleton and schema_generation=1
    and not photo_writes_enabled and not mcp_enabled and not repair_enabled
    and write_boundary_installed_at is not null for update;
  if not found then raise exception 'cutover_requires_closed_gates_and_write_boundary'; end if;
end $$;
create or replace function public.photo_cutover_validate_choice(p_choice jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(p_choice)<>'object' or not (p_choice ?& array['digest','expected_before_image_digest','canonical_photo_id','canonical_job_id','approved_by','approved_at'])
    or (p_choice->>'digest') !~ '^[0-9a-f]{64}$' or (p_choice->>'expected_before_image_digest') !~ '^[0-9a-f]{64}$'
    or p_choice->>'canonical_photo_id' is null or p_choice->>'canonical_job_id' is null
    or p_choice->>'approved_at' is null or (p_choice->>'approved_at')::timestamptz>clock_timestamp()
  then raise exception 'invalid_cutover_choice'; end if;
  perform public.photo_require_actor((p_choice->>'approved_by')::uuid);
  if not exists(select 1 from public.user_profiles where user_id=(p_choice->>'approved_by')::uuid and role='admin')
  then raise exception 'cutover_approval_requires_administrator'; end if;
end $$;
create or replace function public.photo_cutover_begin(p_mapping jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_cutover_runs; c jsonb;
begin
  perform public.photo_cutover_require_closed();
  if p_mapping->>'version' is distinct from '1' or jsonb_typeof(p_mapping->'groups') is distinct from 'array'
    or p_mapping->>'project_ref' is null or p_mapping->>'approved_at' is null
    or (p_mapping->>'approved_at')::timestamptz>clock_timestamp() then raise exception 'invalid_cutover_mapping'; end if;
  perform public.photo_require_actor((p_mapping->>'approved_by')::uuid);
  if not exists(select 1 from public.user_profiles where user_id=(p_mapping->>'approved_by')::uuid and role='admin')
  then raise exception 'cutover_approval_requires_administrator'; end if;
  if exists(select 1 from jsonb_array_elements(p_mapping->'groups') x group by x->>'digest' having count(*)>1)
  then raise exception 'duplicate_cutover_choice'; end if;
  for c in select value from jsonb_array_elements(p_mapping->'groups') loop perform public.photo_cutover_validate_choice(c); end loop;
  select * into r from public.photo_cutover_runs where mapping_digest=public.photo_cutover_hash(p_mapping) and status<>'rolled_back';
  if found then return to_jsonb(r); end if;
  if exists(select 1 from public.photo_cutover_runs where status<>'rolled_back') then raise exception 'cutover_run_already_exists'; end if;
  insert into public.photo_cutover_runs(mapping,mapping_digest,generation)
    select p_mapping,public.photo_cutover_hash(p_mapping),generation from public.photo_cutover_epoch where singleton returning * into r;
  return to_jsonb(r);
end $$;
create or replace function public.photo_cutover_export(p_run_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',1,'project_ref',r.mapping->>'project_ref','run_id',r.id,'mapping',r.mapping,
    'groups',coalesce((select jsonb_agg(jsonb_build_object('digest',c->>'digest','rows',
      coalesce(g.before_rows,public.photo_cutover_snapshot(c->>'digest')->'rows'),
      'expected_before_image_digest',c->>'expected_before_image_digest') order by c->>'digest')
      from jsonb_array_elements(r.mapping->'groups') c left join public.photo_cutover_groups g
      on g.run_id=r.id and g.digest=c->>'digest'),'[]')) from public.photo_cutover_runs r where r.id=p_run_id;
$$;
create or replace function public.photo_cutover_apply(p_run_id uuid,p_digest text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_cutover_runs; g public.photo_cutover_groups; c jsonb; snap jsonb; rows_before jsonb; instant timestamptz;
begin
  perform public.photo_cutover_require_closed();
  select * into r from public.photo_cutover_runs where id=p_run_id for update;
  if not found or r.status not in ('cleaning','indexed') then raise exception 'invalid_cutover_run'; end if;
  select value into c from jsonb_array_elements(r.mapping->'groups') where value->>'digest'=p_digest;
  if c is null then raise exception 'unapproved_cutover_group'; end if;
  perform public.photo_cutover_validate_choice(c);
  -- Closed gates fence app callers; this table lock also fences privileged
  -- concurrent inserts and detects a newly introduced member of the group.
  lock table public.photos in share row exclusive mode;
  snap:=public.photo_cutover_snapshot(p_digest);
  select * into g from public.photo_cutover_groups where run_id=p_run_id and digest=p_digest;
  if found then
    if g.choice<>c or g.after_rows<>snap->'rows' then raise exception 'cutover_group_drift'; end if;
    return jsonb_build_object('status','replayed','digest',p_digest);
  end if;
  rows_before:=snap->'rows';
  if snap->>'expected_before_image_digest' is distinct from c->>'expected_before_image_digest'
    or jsonb_array_length(rows_before)<2
    or exists(select 1 from jsonb_array_elements(rows_before) x where x->>'content_sha256' is distinct from p_digest
      or x->>'deleted_at' is not null or x->>'duplicate_of' is not null)
    or not exists(select 1 from public.photos where id=(c->>'canonical_photo_id')::uuid
      and job_id=(c->>'canonical_job_id')::uuid and content_sha256=p_digest and deleted_at is null)
    -- Cleanup preserves the selected existing owning job, including an inactive
    -- legacy job. New destinations remain the separate confirmed move workflow.
    or not exists(select 1 from public.jobs where id=(c->>'canonical_job_id')::uuid)
  then raise exception 'cutover_group_drift'; end if;
  instant:=clock_timestamp();
  perform set_config('dws.cutover_mutation','yes',true);
  update public.photos set content_sha256=null,legacy_content_sha256=p_digest,
    duplicate_of=(c->>'canonical_photo_id')::uuid,deleted_at=instant,
    deleted_by=(c->>'approved_by')::uuid,purge_after=instant+interval '30 days'
    where content_sha256=p_digest and id<>(c->>'canonical_photo_id')::uuid;
  perform set_config('dws.cutover_mutation','no',true);
  insert into public.photo_cutover_groups(run_id,digest,choice,before_rows,after_rows,applied_at)
    values(p_run_id,p_digest,c,rows_before,public.photo_cutover_snapshot(p_digest)->'rows',instant);
  return jsonb_build_object('status','applied','digest',p_digest);
end $$;

create or replace function public.photo_cutover_index_valid(p_name text,p_global boolean)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.oid=to_regclass('public.'||p_name) and i.indrelid='public.photos'::regclass
    and i.indisunique and i.indisvalid and i.indisready and i.indexprs is null
    and i.indnkeyatts=case when p_global then 1 else 2 end
    and i.indnatts=i.indnkeyatts
    and pg_get_expr(i.indpred,i.indrelid)='(content_sha256 IS NOT NULL)'
    and (select array_agg(a.attname::text order by k.ordinality) from unnest(i.indkey) with ordinality k(attnum,ordinality)
      join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)
      =case when p_global then array['content_sha256'] else array['job_id','content_sha256'] end);
$$;
create or replace function public.photo_cutover_finish(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_cutover_runs; g public.photo_cutover_groups;
begin
  perform public.photo_cutover_require_closed();
  select * into r from public.photo_cutover_runs where id=p_run_id for update;
  if not found or r.status not in ('cleaning','indexed') then raise exception 'invalid_cutover_run'; end if;
  perform public.photo_require_actor((r.mapping->>'approved_by')::uuid);
  if not exists(select 1 from public.user_profiles where user_id=(r.mapping->>'approved_by')::uuid and role='admin')
  then raise exception 'cutover_approval_requires_administrator'; end if;
  lock table public.photos in share row exclusive mode;
  for g in select * from public.photo_cutover_groups where run_id=p_run_id loop
    perform public.photo_cutover_validate_choice(g.choice);
    if public.photo_cutover_snapshot(g.digest)->'rows' is distinct from g.after_rows then raise exception 'cutover_group_drift'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(r.mapping->'groups') c where not exists(
    select 1 from public.photo_cutover_groups journal where journal.run_id=p_run_id and journal.digest=c->>'digest' and journal.rolled_back_at is null))
    or exists(select 1 from public.photos where content_sha256 is not null group by content_sha256 having count(*)>1)
  then raise exception 'cutover_duplicates_remaining'; end if;
  create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null;
  if not public.photo_cutover_index_valid('photos_content_sha256',true) then raise exception 'cutover_global_index_invalid'; end if;
  drop index if exists public.photos_job_sha;
  update public.photo_cutover_runs set status='indexed' where id=p_run_id;
  return jsonb_build_object('status','indexed','global_index_valid',true);
end $$;

create or replace function public.photo_cutover_rollback(p_run_id uuid,p_before_image jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_cutover_runs; g public.photo_cutover_groups; item jsonb; restored integer:=0; started timestamptz:=clock_timestamp();
begin
  select * into r from public.photo_cutover_runs where id=p_run_id;
  if not found then raise exception 'invalid_cutover_run'; end if;
  perform public.photo_require_actor((r.mapping->>'approved_by')::uuid);
  if not exists(select 1 from public.user_profiles where user_id=(r.mapping->>'approved_by')::uuid and role='admin')
  then raise exception 'cutover_approval_requires_administrator'; end if;
  -- Refusal is a committed response, so these emergency gate closures survive.
  update public.photo_release_state set photo_writes_enabled=false,mcp_enabled=false,repair_enabled=false,
    updated_by=(r.mapping->>'approved_by')::uuid,updated_at=clock_timestamp() where singleton;
  perform public.photo_cutover_require_closed();
  select * into r from public.photo_cutover_runs where id=p_run_id for update;
  if not found or p_before_image->>'version' is distinct from '1' or p_before_image->>'run_id' is distinct from p_run_id::text
    or p_before_image->'mapping' is distinct from r.mapping then raise exception 'invalid_cutover_before_image'; end if;
  lock table public.photos in share row exclusive mode;
  if r.generation is distinct from (select generation from public.photo_cutover_epoch where singleton) then
    return jsonb_build_object('status','forward_fix_required','gates_closed',true,'disable_vercel_cron',true,'reason','new_writes_or_purge');
  end if;
  if r.status='rolled_back' then return jsonb_build_object('status','rolled_back','restored',0); end if;
  -- Validate the entire remaining rollback before changing an index or a row.
  for g in select * from public.photo_cutover_groups where run_id=p_run_id and rolled_back_at is null loop
    if clock_timestamp()-started>interval '20 seconds' then raise exception 'cutover_validation_budget_exhausted'; end if;
    select value into item from jsonb_array_elements(p_before_image->'groups') where value->>'digest'=g.digest;
    if item is null or item->'rows' is distinct from g.before_rows
      or public.photo_cutover_hash(item->'rows') is distinct from g.choice->>'expected_before_image_digest'
      or public.photo_cutover_snapshot(g.digest)->'rows' is distinct from g.after_rows then
      return jsonb_build_object('status','forward_fix_required','gates_closed',true,'disable_vercel_cron',true,'reason','before_image_or_row_drift');
    end if;
  end loop;
  create unique index if not exists photos_job_sha on public.photos(job_id,content_sha256) where content_sha256 is not null;
  if not public.photo_cutover_index_valid('photos_job_sha',false) then raise exception 'cutover_old_index_invalid'; end if;
  drop index if exists public.photos_content_sha256;
  update public.photo_cutover_runs set status='rolling_back' where id=p_run_id;
  perform set_config('dws.cutover_mutation','yes',true);
  for g in select * from public.photo_cutover_groups where run_id=p_run_id and rolled_back_at is null order by digest limit 100 loop
    exit when clock_timestamp()-started>interval '25 seconds';
    -- These are the only columns cleanup changed; full-row equality above
    -- proves all original names, paths, metadata and ownership are untouched.
    update public.photos p set content_sha256=b.content_sha256,legacy_content_sha256=b.legacy_content_sha256,
      duplicate_of=b.duplicate_of,deleted_at=b.deleted_at,deleted_by=b.deleted_by,purge_after=b.purge_after
      from jsonb_populate_recordset(null::public.photos,g.before_rows) b where p.id=b.id;
    update public.photo_cutover_groups set rolled_back_at=clock_timestamp() where run_id=p_run_id and digest=g.digest;
    restored:=restored+1;
  end loop;
  perform set_config('dws.cutover_mutation','no',true);
  if not exists(select 1 from public.photo_cutover_groups where run_id=p_run_id and rolled_back_at is null) then
    update public.photo_cutover_runs set status='rolled_back' where id=p_run_id;
    return jsonb_build_object('status','rolled_back','restored',restored);
  end if;
  return jsonb_build_object('status','rolling_back','restored',restored);
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'photo_cutover_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
