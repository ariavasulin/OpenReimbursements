-- CONCURRENTLY so this does not lock out writes.
--
-- Apply each statement individually via the positional form — see
-- supabase/migrations/README.md § Files that must be applied statement by
-- statement.

-- photos_job_captured is (job_id, captured_at desc) — it lacks the `id`
-- tiebreaker that GET /api/photos keysets on, so every page still sorts.
-- Replace it with the full key. Create the new index before dropping the old
-- one so no window exists without coverage.
create index concurrently if not exists photos_job_captured_id
  on public.photos (job_id, captured_at desc, id desc);

drop index concurrently if exists public.photos_job_captured;

-- Global (job-less) browse and search: GET /api/photos with only `q`,
-- `uploader`, or `tags` set still orders by captured_at desc, id desc.
create index concurrently if not exists photos_captured_id
  on public.photos (captured_at desc, id desc);

-- The Uploader filter has no index today.
create index concurrently if not exists photos_uploader_captured_id
  on public.photos (uploader_id, captured_at desc, id desc);

-- GET /api/photo-jobs ranks jobs by most recent upload and pulls the 4 newest
-- thumbs per job, both keyed on created_at. There is no index on created_at
-- today, so that endpoint sequentially scans the whole table on every call.
create index concurrently if not exists photos_job_created
  on public.photos (job_id, created_at desc);
