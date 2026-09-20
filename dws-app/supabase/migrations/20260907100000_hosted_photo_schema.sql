-- Expand only. No existing photo writes are revoked and no identity is selected.
-- Operator activation is the separately callable photo_install_write_boundary().
begin;

alter table public.photos
  add column if not exists deleted_at timestamptz,
  -- Audit identity uses Auth so the legacy unqualified uploader embed remains unambiguous.
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists purge_after timestamptz,
  add column if not exists legacy_content_sha256 text,
  add column if not exists duplicate_of uuid references public.photos(id),
  add column if not exists upload_attempt_id uuid,
  add column if not exists migration_item_id uuid,
  add column if not exists upload_warnings jsonb not null default '[]',
  add column if not exists purge_claimed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.photos'::regclass and conname='photos_trash_consistent') then
    alter table public.photos add constraint photos_trash_consistent check (
      (deleted_at is null and deleted_by is null and purge_after is null and purge_claimed_at is null)
      or (deleted_at is not null and deleted_by is not null and purge_after is not null and purge_after=deleted_at+interval '30 days'));
    alter table public.photos add constraint photos_legacy_duplicate_consistent check (
      (duplicate_of is null and legacy_content_sha256 is null) or
      (duplicate_of is not null and duplicate_of<>id and legacy_content_sha256 is not null and legacy_content_sha256 ~ '^[0-9a-f]{64}$'
       and content_sha256 is null and deleted_at is not null));
  end if;
end $$;
create index if not exists photos_trash_due on public.photos(purge_after,id) where deleted_at is not null;
create index if not exists photos_duplicate_of on public.photos(duplicate_of) where duplicate_of is not null;

-- Remove every SELECT/ALL policy: any permissive alternative would reveal trash.
-- Existing policies in this repository split SELECT and writes; refuse ALL policy
-- drift rather than silently delete an unknown write policy during expansion.
do $$ declare p record; begin
  if exists(select 1 from pg_policies where schemaname='public' and tablename='photos' and cmd='ALL') then
    raise exception 'unexpected photos ALL policy; review expansion before applying';
  end if;
  for p in select policyname from pg_policies where schemaname='public' and tablename='photos' and cmd='SELECT' loop
    execute format('drop policy %I on public.photos',p.policyname);
  end loop;
end $$;
create policy photos_select on public.photos for select to authenticated using (deleted_at is null);

create table if not exists public.photo_release_state (
  singleton boolean primary key default true check(singleton),
  photo_writes_enabled boolean not null default false,
  mcp_enabled boolean not null default false,
  repair_enabled boolean not null default false,
  schema_generation integer not null default 1 check(schema_generation>0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.user_profiles(user_id),
  write_boundary_installed_at timestamptz
);
insert into public.photo_release_state(singleton) values(true) on conflict do nothing;

create table if not exists public.migration_batches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.user_profiles(user_id),
  origin text not null default 'mcp' check(origin in ('mcp','ui')),
  script_name text not null check(script_name in ('migrate_photos','add_photos')),
  status text not null default 'draft' check(status in ('draft','approved','running','interrupted','completed','cancelled')),
  approved_by uuid references public.user_profiles(user_id), approved_at timestamptz,
  approved_rules jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((approved_at is null)=(approved_by is null))
);
create table if not exists public.migration_sources (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.migration_batches(id),
  job_id uuid not null references public.jobs(id),
  kind text not null check(kind in ('directory','files')), label text not null,
  scan_id uuid, sealed_scan_id uuid, sealed_fingerprint text check(sealed_fingerprint ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz, selection_rules jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((sealed_at is null)=(sealed_scan_id is null)),
  check ((sealed_at is null)=(sealed_fingerprint is null))
);
create index if not exists migration_sources_batch on public.migration_sources(batch_id,id);
create table if not exists public.migration_inventory_chunks (
  source_id uuid not null references public.migration_sources(id), scan_id uuid not null,
  chunk_number integer not null check(chunk_number>=0), payload_digest text not null check(payload_digest ~ '^[0-9a-f]{64}$'),
  entry_count integer not null check(entry_count between 0 and 500), encoded_bytes integer not null check(encoded_bytes between 0 and 1048576),
  total_bytes bigint not null check(total_bytes between 0 and 9007199254740991),
  counts jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key(source_id,scan_id,chunk_number)
);
create table if not exists public.migration_items (
  id uuid primary key default gen_random_uuid(), source_id uuid not null references public.migration_sources(id),
  relative_path text not null check(relative_path<>'' and relative_path !~ '^/' and relative_path !~ '(^|/)\.\.(/|$)'),
  revision integer not null check(revision>0), is_current boolean not null default true, scan_id uuid not null,
  source_signature text not null, source_mtime bigint, original_name text not null,
  original_bytes bigint not null check(original_bytes between 0 and 9007199254740991), mime_type text not null,
  sidecar jsonb, content_sha256 text check(content_sha256 ~ '^[0-9a-f]{64}$'),
  upload_attempt_id uuid not null default gen_random_uuid() unique,
  photo_id uuid not null default gen_random_uuid() unique,
  original_path text, thumb_path text, preview_path text, sidecar_path text,
  status text not null default 'pending' check(status in ('pending','hashing','waiting_claim','uploading','finalizing','retryable_failed','job_conflict','restore_required','completed','skipped_duplicate','skipped_missing','skipped_unsupported','skipped_failed','skipped_user','cancelled')),
  progress_bytes bigint not null default 0 check(progress_bytes>=0),
  canonical_photo_id uuid references public.photos(id) on delete set null, canonical_job_id uuid references public.jobs(id),
  error jsonb, warnings jsonb not null default '[]', result jsonb, finalize_payload jsonb,
  lease_generation bigint not null default 0, lease_expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(source_id,relative_path,revision)
);
create unique index if not exists migration_items_current_path on public.migration_items(source_id,relative_path) where is_current;
create index if not exists migration_items_queue on public.migration_items(source_id,status,id) where is_current;
create table if not exists public.photo_upload_attempts (
  id uuid primary key, actor_id uuid not null references public.user_profiles(user_id), job_id uuid not null references public.jobs(id),
  source_signature text not null, content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
  photo_id uuid not null unique, original_name text not null, original_bytes bigint not null check(original_bytes between 0 and 9007199254740991), mime_type text not null,
  original_path text not null, thumb_path text not null, preview_path text not null, sidecar_path text,
  status text not null default 'pending' check(status in ('pending','uploading','finalizing','completed','duplicate_active','duplicate_trashed','cancelled','retryable_failed')),
  lease_generation bigint not null default 0, lease_expires_at timestamptz,
  result jsonb, finalize_payload jsonb, warnings jsonb not null default '[]', error jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.photo_content_claims (
  content_sha256 text primary key check(content_sha256 ~ '^[0-9a-f]{64}$'),
  migration_item_id uuid references public.migration_items(id), upload_attempt_id uuid references public.photo_upload_attempts(id),
  actor_id uuid not null references public.user_profiles(user_id),
  lease_generation bigint not null check(lease_generation>0), lease_expires_at timestamptz not null,
  owner_generation bigint not null,
  check(num_nonnulls(migration_item_id,upload_attempt_id)=1)
);
create table if not exists public.photo_action_batches (
  id uuid primary key default gen_random_uuid(), created_by uuid not null references public.user_profiles(user_id),
  origin text not null check(origin in ('mcp','ui')),
  action text not null check(action in ('move','trash','restore')),
  selector jsonb not null default '{}', destination_job_id uuid references public.jobs(id),
  status text not null default 'draft' check(status in ('draft','approved','running','interrupted','completed','cancelled')),
  approved_by uuid references public.user_profiles(user_id), approved_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((approved_at is null)=(approved_by is null)),
  check (action<>'move' or destination_job_id is not null)
);
create table if not exists public.photo_action_items (
  batch_id uuid not null references public.photo_action_batches(id), photo_id uuid not null,
  expected_job_id uuid not null references public.jobs(id), expected_deleted_at timestamptz,
  status text not null default 'pending' check(status in ('pending','running','applied','retryable_failed','conflict','skipped','cancelled')),
  actor_id uuid references public.user_profiles(user_id), result jsonb, error jsonb,
  lease_generation bigint not null default 0, lease_expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(batch_id,photo_id)
);
create table if not exists public.dws_action_handoffs (
  id uuid primary key default gen_random_uuid(), token_digest text not null unique check(token_digest ~ '^[0-9a-f]{64}$'),
  script_name text not null check(script_name in ('migrate_photos','add_photos','move_photos','remove_photos','restore_photos')),
  requested_input jsonb not null default '{}', expires_at timestamptz not null,
  consumed_at timestamptz, consumed_by uuid references public.user_profiles(user_id),
  migration_batch_id uuid unique references public.migration_batches(id), photo_action_batch_id uuid unique references public.photo_action_batches(id),
  created_at timestamptz not null default now(),
  check ((consumed_at is null and consumed_by is null and num_nonnulls(migration_batch_id,photo_action_batch_id)=0)
    or (consumed_at is not null and consumed_by is not null and num_nonnulls(migration_batch_id,photo_action_batch_id)=1)),
  check(migration_batch_id is null or script_name in ('migrate_photos','add_photos')),
  check(photo_action_batch_id is null or script_name in ('move_photos','remove_photos','restore_photos'))
);
create table if not exists public.issue_report_submissions (
  id uuid primary key default gen_random_uuid(), client_key text unique,
  payload_digest text not null check(payload_digest ~ '^[0-9a-f]{64}$'), normalized_payload jsonb not null,
  attribution jsonb not null default '{}', dedupe_expires_at timestamptz not null default now()+interval '24 hours',
  status text not null default 'pending' check(status in ('pending','publishing','published','failed','unknown')),
  lease_generation bigint not null default 0, lease_expires_at timestamptz,
  github_number bigint, issue_url text, error jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((status='published')=(github_number is not null and issue_url is not null))
);
create index if not exists issue_report_digest on public.issue_report_submissions(payload_digest,created_at desc);
create table if not exists public.photo_repair_progress (
  singleton boolean primary key default true check(singleton),
  lease_holder uuid, lease_generation bigint not null default 0, lease_expires_at timestamptz,
  photo_cursor jsonb, storage_cursor jsonb, purge_cursor jsonb,
  inventory_complete boolean not null default false, inventory_generation uuid,
  updated_at timestamptz not null default now()
);

-- Default privileges in the baseline grant ALL to clients; RLS alone does not
-- protect TRUNCATE. Explicitly strip every privilege on every private ledger.
do $$ declare t text; begin
  foreach t in array array['photo_release_state','migration_batches','migration_sources','migration_inventory_chunks','migration_items','photo_upload_attempts','photo_content_claims','photo_action_batches','photo_action_items','dws_action_handoffs','issue_report_submissions','photo_repair_progress'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;
commit;
