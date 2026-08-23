-- Baseline capture of the four receipt-images policies on storage.objects,
-- transcribed from live pg_policies output (2026-08-22). These were created by
-- hand in the Supabase dashboard before migrations were checked in; this file
-- records them so a fresh database can be rebuilt from the repo alone.
--
-- The photos-bucket storage policies are NOT here — they live in
-- 00000000000003_photos_schema.sql.
--
-- Idempotent: drop-if-exists / create pairs. Do not re-apply to the existing
-- project unless a policy has drifted.
--
-- Fidelity notes, matching pg_policies exactly:
--   * "Upload 13hfyy5_0" applies to role `authenticated`; the other three were
--     created without a TO clause and therefore apply to `public` (all roles).
--   * "users can update 13hfyy5_0" has no explicit WITH CHECK; Postgres then
--     re-uses the USING clause for the check, which matches the live NULL
--     with_check in pg_policies.

drop policy if exists "Upload 13hfyy5_0" on storage.objects;
create policy "Upload 13hfyy5_0" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users select their own files 13hfyy5_0" on storage.objects;
create policy "users select their own files 13hfyy5_0" on storage.objects
  for select
  using (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users can update 13hfyy5_0" on storage.objects;
create policy "users can update 13hfyy5_0" on storage.objects
  for update
  using (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users can delete their own files 13hfyy5_0" on storage.objects;
create policy "users can delete their own files 13hfyy5_0" on storage.objects
  for delete
  using (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
