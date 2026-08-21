-- DWS Photos hub schema: jobs + photos tables, RLS, storage own-prefix INSERT/SELECT/UPDATE policies.
-- Strictly additive: no existing table, bucket, or policy is altered.
--
-- Prerequisite (storage, applied separately — not table DDL):
--   insert into storage.buckets (id, name, public, file_size_limit)
--   values ('photos', 'photos', true, 53687091200)   -- 50 GiB
--   on conflict (id) do nothing;
--
-- Idempotent end to end; apply to production with:
--   env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f dws-app/db/photos-schema.sql

create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  job_number  text unique not null,           -- office JobNo, e.g. '3612'
  name        text not null,
  location    text,
  is_active   boolean not null default true,
  synced_at   timestamptz
);

create table if not exists public.photos (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs(id),
  uploader_id    uuid not null references public.user_profiles(user_id),
  kind           text not null check (kind in ('image','video','file')),
  sheet_number   text,                         -- optional, free-entry
  tags           text[] not null default '{}',
  captured_at    timestamptz,                  -- EXIF capture time; upload time as fallback
  original_path  text not null,                -- byte-for-byte original in storage
  original_bytes bigint,
  mime_type      text,
  original_name  text,                         -- filename as uploaded (download restores it)
  thumb_path     text,                         -- grid thumbnail (nullable: 'file' kind has none)
  preview_path   text,                         -- lightbox preview / video poster
  duration_secs  numeric,                      -- video only
  created_at     timestamptz not null default now()
);

create index if not exists photos_job_captured on public.photos (job_id, captured_at desc);
create index if not exists photos_tags_gin     on public.photos using gin (tags);
create index if not exists photos_sheet        on public.photos (job_id, sheet_number);

alter table public.jobs   enable row level security;
alter table public.photos enable row level security;

-- jobs: read-only for signed-in users; writes are service-role only (bypasses RLS)
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select to authenticated using (true);

-- photos_update is open to every signed-in user (the "anyone fixes tags" rule); routes whitelist columns
drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos
  for select to authenticated using (true);

drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos
  for insert to authenticated with check (uploader_id = auth.uid());

drop policy if exists photos_update on public.photos;
create policy photos_update on public.photos
  for update to authenticated using (true) with check (true);

drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos
  for delete to authenticated using (uploader_id = auth.uid() or is_admin());

-- storage: signed-in users may write only under their own prefix in the photos bucket.
-- Keys: originals/{uploader_id}/{photo_id}/{filename}
--       derived/{uploader_id}/{photo_id}_thumb.webp | {photo_id}_preview.webp
drop policy if exists photos_storage_insert on storage.objects;
create policy photos_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- Uploads use upsert (insert-or-update), so Storage evaluates SELECT and UPDATE
-- policies even for a brand-new object. Same own-prefix rule as the INSERT policy.
drop policy if exists photos_storage_select on storage.objects;
create policy photos_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists photos_storage_update on storage.objects;
create policy photos_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = auth.uid()::text
  );
