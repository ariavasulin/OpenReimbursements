-- DWS Photos hub schema: jobs + photos tables, RLS, and the two read policies.
-- Strictly additive: no existing table, bucket, or policy is altered.
--
-- Prerequisite (storage, not table DDL): the 'photos' bucket. It is created by
-- 20260823100000_review_fixes.sql, along with 'receipt-images'; neither was in
-- the `--schema public` baseline dump.
--
-- Historical baseline for the photos hub. Production already has it; it is kept
-- as the record of the original schema, not as something to re-run by hand.
-- Apply the migrations in filename order (or via the Supabase CLI), never this
-- file on its own.

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

-- photos_job_captured (job_id, captured_at desc) used to be created here. It was
-- superseded by photos_job_captured_id (job_id, captured_at desc, id desc) in
-- 20260822120100_add_photos_indexes.sql, which drops it. Leaving the create
-- here resurrected the dropped index every time this file was re-run.
create index if not exists photos_tags_gin     on public.photos using gin (tags);
create index if not exists photos_sheet        on public.photos (job_id, sheet_number);

alter table public.jobs   enable row level security;
alter table public.photos enable row level security;

-- The photos write policies (photos_insert/update/delete and the photos-bucket
-- storage policies) are NOT defined here. Their source of truth is:
--   20260822130100_rls_photos_tighten_update.sql       (photos table)
--   20260822130200_rls_storage_scalar_subqueries.sql   (photos bucket)

-- jobs: read-only for signed-in users; writes are service-role only (bypasses RLS)
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select to authenticated using (true);

-- photos: readable by every signed-in user
drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos
  for select to authenticated using (true);

-- Date provenance. Legacy rows default to 'upload' (their captured_at may be
-- the server's now() fallback).
alter table public.photos
  add column if not exists captured_at_source text not null default 'upload'
    check (captured_at_source in ('exif','xmp','camera','file','upload'));

-- XMP sidecars attach to their image row.
-- The .xmp object lives beside the original (originals/{uid}/{photo_id}/{base}.xmp);
-- sidecar_name keeps the filename as uploaded so downloads restore it.
alter table public.photos
  add column if not exists sidecar_path text,
  add column if not exists sidecar_name text;

-- Server-made H.264 playback rendition.
-- playback_path points at derived/{uid}/{photo_id}_playback.mp4 once the
-- repair cron transcodes the original; playback_skipped_reason records why a
-- video was deliberately not transcoded (over the size/duration cap) so the
-- sweep stops retrying it. Clear both to re-queue a video.
alter table public.photos
  add column if not exists playback_path text,
  add column if not exists playback_skipped_reason text;

-- Content-hash dedupe. content_sha256 is the SHA-256 of the original's bytes
-- (null for files over the 100 MB hashing cap or clients without WebCrypto).
-- The partial unique index makes the same bytes land at most once PER JOB —
-- the same photo in two jobs is two rows.
alter table public.photos
  add column if not exists content_sha256 text;
create unique index if not exists photos_job_sha
  on public.photos (job_id, content_sha256)
  where content_sha256 is not null;
