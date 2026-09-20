-- One renewable cron owner; permanent path fences bridge Postgres and Storage.
begin;
alter table public.photos add column if not exists poster_skipped_reason text;
create table if not exists public.photo_repair_deleted_paths (
  path text primary key,
  authorized_at timestamptz not null default clock_timestamp()
);
alter table public.photo_repair_deleted_paths enable row level security;
revoke all on public.photo_repair_deleted_paths from public,anon,authenticated;
grant all on public.photo_repair_deleted_paths to service_role;
-- Modern upload ledgers reserve identities forever. Legacy photos need an
-- explicit reservation after physical purge so old action IDs cannot be rebound.
create table if not exists public.photo_repair_retired_ids (
  id uuid primary key,
  retired_at timestamptz not null default clock_timestamp()
);
alter table public.photo_repair_retired_ids enable row level security;
revoke all on public.photo_repair_retired_ids from public,anon,authenticated;
grant all on public.photo_repair_retired_ids to service_role;

-- Acquire the existing corpus reservation lock before row/path triggers on both
-- ledgers. Migration already has this statement trigger from Phase 3.
drop trigger if exists photo_repair_reservation_lock on public.photo_upload_attempts;
create trigger photo_repair_reservation_lock before insert on public.photo_upload_attempts
  for each statement execute function public.migration_reserve_uuid_lock();
create or replace function public.photo_repair_guard_owner_ids()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from new_owners n join public.photo_repair_retired_ids r on r.id=n.photo_id) then raise exception 'conflict'; end if;
  return null;
end $$;
drop trigger if exists photo_repair_guard_owner_ids on public.photo_upload_attempts;
create trigger photo_repair_guard_owner_ids after insert on public.photo_upload_attempts
  referencing new table as new_owners for each statement execute function public.photo_repair_guard_owner_ids();
drop trigger if exists photo_repair_guard_owner_ids on public.migration_items;
create trigger photo_repair_guard_owner_ids after insert on public.migration_items
  referencing new table as new_owners for each statement execute function public.photo_repair_guard_owner_ids();

create or replace function public.photo_repair_guard_photo_id()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  -- AFTER INSERT runs after any unique-index wait for a concurrent purge. Its
  -- fresh snapshot sees that purge's committed tombstone before accepting reuse.
  if exists(select 1 from public.photo_repair_retired_ids where id=new.id) then raise exception 'conflict'; end if;
  return new;
end $$;
drop trigger if exists photo_repair_guard_photo_id on public.photos;
create trigger photo_repair_guard_photo_id after insert or update of id on public.photos for each row execute function public.photo_repair_guard_photo_id();

insert into public.photo_repair_progress(singleton) values(true) on conflict do nothing;

create or replace function public.photo_repair_paths(p jsonb)
returns text[] language sql immutable set search_path=public,pg_temp as $$
  select coalesce(array_agg(distinct path order by path),'{}') from unnest(array[
    p->>'original_path',p->>'thumb_path',p->>'preview_path',p->>'sidecar_path',p->>'playback_path',
    'derived/'||(p->>'uploader_id')||'/'||(p->>'id')||'_thumb.webp',
    'derived/'||(p->>'uploader_id')||'/'||(p->>'id')||'_preview.webp',
    'derived/'||(p->>'uploader_id')||'/'||(p->>'id')||'_playback.mp4'
  ]) as paths(path) where path is not null and path<>'';
$$;

-- The lock is held through the insert/update commit. A deletion authorization
-- takes this same path lock before checking current owners and saving its fence.
create or replace function public.photo_repair_guard_paths()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare next_paths text[]; old_paths text[]:='{}'; v_path text;
begin
  -- INSERT ... ON CONFLICT replays an existing immutable attempt. Its paths may
  -- already be retired; the create RPC still checks the full source binding.
  if tg_op='INSERT' and tg_table_name='photo_upload_attempts' then
    if exists(select 1 from public.photo_upload_attempts where id=new.id and photo_id=new.photo_id) then return new; end if;
  end if;
  if tg_table_name='photos' then
    if new.duplicate_of is not null and (tg_op='INSERT' or new.duplicate_of is distinct from old.duplicate_of) then
      perform 1 from public.photos where id=new.duplicate_of and purge_claimed_at is null for share;
      if not found then raise exception 'conflict'; end if;
    end if;
    next_paths:=public.photo_repair_paths(to_jsonb(new));
    if tg_op='UPDATE' then old_paths:=public.photo_repair_paths(to_jsonb(old)); end if;
  else
    next_paths:=array[new.original_path,new.thumb_path,new.preview_path,new.sidecar_path];
    if tg_op='UPDATE' then
      old_paths:=array[old.original_path,old.thumb_path,old.preview_path,old.sidecar_path];
      if old.status in ('cancelled','skipped_missing','skipped_unsupported','skipped_failed','skipped_user')
        and new.status not in ('cancelled','skipped_missing','skipped_unsupported','skipped_failed','skipped_user') then old_paths:='{}'; end if;
    end if;
    if new.original_path is null and new.thumb_path is null and new.preview_path is null and new.sidecar_path is null then return new; end if;
  end if;
  for v_path in select distinct value from unnest(next_paths) value
    where value is not null and value<>'' and not exists(select 1 from unnest(old_paths) previous where previous=value) order by value loop
    perform pg_advisory_xact_lock(hashtextextended('photo-path:'||v_path,0));
    if exists(select 1 from public.photo_repair_deleted_paths d where d.path=v_path) then raise exception 'path_retired'; end if;
  end loop;
  return new;
end $$;
drop trigger if exists photo_repair_guard_paths on public.photos;
create trigger photo_repair_guard_paths before insert or update on public.photos for each row execute function public.photo_repair_guard_paths();
drop trigger if exists photo_repair_guard_paths on public.photo_upload_attempts;
create trigger photo_repair_guard_paths before insert or update on public.photo_upload_attempts for each row execute function public.photo_repair_guard_paths();
drop trigger if exists photo_repair_guard_paths on public.migration_items;
create trigger photo_repair_guard_paths before insert or update on public.migration_items for each row execute function public.photo_repair_guard_paths();

create or replace function public.photo_repair_assert_lease(p_holder uuid,p_generation bigint)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_repair_progress;
begin
  perform public.photo_require_gate('repair');
  select * into r from public.photo_repair_progress where singleton for update;
  if not found or p_holder is null or p_generation is null or r.lease_holder is distinct from p_holder
    or r.lease_generation<>p_generation or coalesce(r.lease_expires_at<=clock_timestamp(),true) then raise exception 'stale_lease'; end if;
end $$;

create or replace function public.photo_repair_acquire(p_holder uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_repair_progress;
begin
  perform public.photo_require_gate('repair');
  if p_holder is null then raise exception 'invalid_input'; end if;
  select * into r from public.photo_repair_progress where singleton for update;
  if not found then raise exception 'photo_gate_closed'; end if;
  if r.lease_expires_at>clock_timestamp() then return null; end if;
  update public.photo_repair_progress set lease_holder=p_holder,lease_generation=lease_generation+1,
    lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp() where singleton returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.photo_repair_renew(p_holder uuid,p_generation bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  update public.photo_repair_progress set lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp() where singleton;
  return true;
end $$;

create or replace function public.photo_repair_checkpoint(p_holder uuid,p_generation bigint,p_photo_cursor jsonb,p_storage_cursor jsonb,p_release boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.photo_repair_progress;
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  if (p_photo_cursor is not null and jsonb_typeof(p_photo_cursor)<>'object') or
    (p_storage_cursor is not null and jsonb_typeof(p_storage_cursor)<>'object') or p_release is null then raise exception 'invalid_input'; end if;
  update public.photo_repair_progress set photo_cursor=p_photo_cursor,storage_cursor=p_storage_cursor,
    inventory_complete=false,lease_holder=case when p_release then null else p_holder end,
    lease_expires_at=case when p_release then null else clock_timestamp()+interval '2 minutes' end,updated_at=clock_timestamp()
    where singleton returning * into r;
  return to_jsonb(r);
end $$;

-- Every retained row is authoritative, including unexpired/claimed trash and
-- inferred derivative destinations. Resumable unfinished attempts stay owned even
-- after lease expiry. Terminal attempts protect late sidecar attachment while the
-- created photo survives. Historical canonical IDs do not own another row's bytes.
create index if not exists photos_repair_paths on public.photos using gin ((array[original_path,thumb_path,preview_path,sidecar_path,playback_path]));
create index if not exists photo_attempts_repair_paths on public.photo_upload_attempts using gin ((array[original_path,thumb_path,preview_path,sidecar_path]));
create index if not exists migration_items_repair_paths on public.migration_items using gin ((array[original_path,thumb_path,preview_path,sidecar_path]));

create or replace function public.photo_repair_path_owned(p_path text,p_exclude_photo uuid default null)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare identity_parts text[];
begin
  identity_parts:=regexp_match(p_path,'^derived/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(thumb[.]webp|preview[.]webp|playback[.]mp4)$');
  if identity_parts is not null and exists(select 1 from public.photos where id=identity_parts[2]::uuid
    and uploader_id=identity_parts[1]::uuid and id is distinct from p_exclude_photo) then return true; end if;
  return exists(select 1 from public.photos p where p.id is distinct from p_exclude_photo
    and array[p.original_path,p.thumb_path,p.preview_path,p.sidecar_path,p.playback_path] @> array[p_path])
  or exists(select 1 from public.photo_upload_attempts a where a.photo_id is distinct from p_exclude_photo
    and array[a.original_path,a.thumb_path,a.preview_path,a.sidecar_path] @> array[p_path]
    and (a.lease_expires_at>clock_timestamp() or (a.result is null and a.status<>'cancelled')
      or exists(select 1 from public.photo_content_claims c where c.upload_attempt_id=a.id and c.lease_expires_at>clock_timestamp())
      or (a.result->>'status'='created' and exists(select 1 from public.photos p where p.id=a.photo_id))))
  or exists(select 1 from public.migration_items i where i.photo_id is distinct from p_exclude_photo
    and array[i.original_path,i.thumb_path,i.preview_path,i.sidecar_path] @> array[p_path]
    and (i.lease_expires_at>clock_timestamp() or (i.result is null and i.status not in ('cancelled','skipped_missing','skipped_unsupported','skipped_failed','skipped_user'))
      or exists(select 1 from public.photo_content_claims c where c.migration_item_id=i.id and c.lease_expires_at>clock_timestamp())
      or (i.result->>'status'='created' and exists(select 1 from public.photos p where p.id=i.photo_id))));
end $$;

create index if not exists photos_repair_purge_order on public.photos ((duplicate_of is null),purge_after,id) where deleted_at is not null;
create index if not exists photo_claims_upload_owner on public.photo_content_claims(upload_attempt_id) where upload_attempt_id is not null;
create index if not exists photo_claims_migration_owner on public.photo_content_claims(migration_item_id) where migration_item_id is not null;

create or replace function public.photo_repair_claim_purge(p_holder uuid,p_generation bigint,p_limit integer default 500)
returns setof public.photos language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos;
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid_input'; end if;
  for p in select * from public.photos candidate where deleted_at is not null and purge_after<=clock_timestamp()
    and not exists(select 1 from public.photos reference where reference.duplicate_of=candidate.id)
    order by (duplicate_of is null),purge_after,id limit p_limit for update skip locked loop
    -- Restore may have completed while the candidate row lock was acquired.
    if p.deleted_at is not null and p.purge_after<=clock_timestamp() then
      update public.photos set purge_claimed_at=coalesce(purge_claimed_at,clock_timestamp()) where id=p.id returning * into p;
      return next p;
    end if;
  end loop;
end $$;

create or replace function public.photo_repair_authorize_delete(p_holder uuid,p_generation bigint,p_path text,p_photo_id uuid default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos;
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  if p_path is null or p_path='' or length(p_path)>4096 then raise exception 'invalid_input'; end if;
  if p_photo_id is not null then
    select * into p from public.photos where id=p_photo_id for update;
    if not found or p.deleted_at is null or p.purge_after>clock_timestamp() or p.purge_claimed_at is null
      or exists(select 1 from public.photos where duplicate_of=p.id)
      or not (p_path=any(public.photo_repair_paths(to_jsonb(p)))) then return false; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('photo-path:'||p_path,0));
  if public.photo_repair_path_owned(p_path,p_photo_id) then return false; end if;
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  insert into public.photo_repair_deleted_paths(path) values(p_path) on conflict do nothing;
  return true;
end $$;

create or replace function public.photo_repair_finish_purge(p_holder uuid,p_generation bigint,p_photo_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos; v_path text;
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  perform pg_advisory_xact_lock(hashtextextended('photo-upload-identity-reservation',0));
  select * into p from public.photos where id=p_photo_id for update;
  if not found then return false; end if;
  if p.deleted_at is null or p.purge_after>clock_timestamp() or p.purge_claimed_at is null
    or exists(select 1 from public.photos where duplicate_of=p.id) then return false; end if;
  foreach v_path in array array[p.original_path,p.thumb_path,p.preview_path,p.sidecar_path,p.playback_path] loop
    if v_path is null then continue; end if;
    perform pg_advisory_xact_lock(hashtextextended('photo-path:'||v_path,0));
    if not public.photo_repair_path_owned(v_path,p.id) then
      if not exists(select 1 from public.photo_repair_deleted_paths d where d.path=v_path)
        or exists(select 1 from storage.objects o where o.bucket_id='photos' and o.name=v_path) then return false; end if;
    end if;
  end loop;
  -- photo_action_items has no photo FK; migration history uses ON DELETE SET NULL.
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  insert into public.photo_repair_retired_ids(id) values(p.id) on conflict do nothing;
  delete from public.photos where id=p.id;
  return true;
end $$;

create or replace function public.photo_repair_delete_dead(p_holder uuid,p_generation bigint,p_photo_id uuid,p_expected_original text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.photos;
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  perform pg_advisory_xact_lock(hashtextextended('photo-upload-identity-reservation',0));
  select * into p from public.photos where id=p_photo_id for update;
  if not found then return false; end if;
  if p.deleted_at is not null or p.original_path is distinct from p_expected_original
    or exists(select 1 from public.photos where duplicate_of=p.id) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('photo-path:'||p.original_path,0));
  if exists(select 1 from storage.objects where bucket_id='photos' and name=p.original_path)
    or public.photo_repair_path_owned(p.original_path,p.id)
    or exists(select 1 from public.photo_upload_attempts a where a.photo_id=p.id and
      (a.lease_expires_at>clock_timestamp() or (a.result is null and a.status<>'cancelled')))
    or exists(select 1 from public.migration_items i where i.photo_id=p.id and
      (i.lease_expires_at>clock_timestamp() or (i.result is null and i.status not in ('cancelled','skipped_missing','skipped_unsupported','skipped_failed','skipped_user'))))
    then return false; end if;
  -- The old repair contract removes the dead active row. Remaining derivatives
  -- become candidates in the independently fenced Storage scan.
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  insert into public.photo_repair_retired_ids(id) values(p.id) on conflict do nothing;
  delete from public.photos where id=p.id;
  return true;
end $$;

create or replace function public.photo_repair_storage_page(p_holder uuid,p_generation bigint,p_after text default null,p_limit integer default 500)
returns table(name text,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid_input'; end if;
  return query select o.name,o.created_at,o.updated_at from storage.objects o
    where o.bucket_id='photos' and (o.name like 'originals/%' or o.name like 'derived/%') and (p_after is null or o.name>p_after) order by o.name limit p_limit;
end $$;

create or replace function public.photo_repair_backlog(p_holder uuid,p_generation bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  perform public.photo_repair_assert_lease(p_holder,p_generation);
  select jsonb_build_object('purge_backlog',count(*),'oldest_due_at',min(purge_after)) into result
    from public.photos where deleted_at is not null and purge_after<=clock_timestamp();
  return result;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname like 'photo_repair_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
commit;
