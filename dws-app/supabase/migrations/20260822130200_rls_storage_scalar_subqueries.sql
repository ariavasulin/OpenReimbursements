-- Same InitPlan treatment for the photos-bucket storage policies. These are
-- evaluated on every object write, and storage.objects is the largest table in
-- the database.
begin;

drop policy if exists photos_storage_insert on storage.objects;
create policy photos_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists photos_storage_select on storage.objects;
create policy photos_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists photos_storage_update on storage.objects;
create policy photos_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] in ('originals', 'derived')
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- The four receipt-images policies, rewritten from the baseline transcription
-- (00000000000001_baseline_storage_policies.sql) with auth.uid() wrapped.
-- Every other clause is byte-identical to the baseline: only the INSERT policy is `to authenticated` (the
-- other three apply to `public`), and the UPDATE policy has no explicit
-- WITH CHECK (Postgres re-uses USING for the check).

drop policy if exists "Upload 13hfyy5_0" on storage.objects;
create policy "Upload 13hfyy5_0" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "users select their own files 13hfyy5_0" on storage.objects;
create policy "users select their own files 13hfyy5_0" on storage.objects
  for select
  using (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "users can update 13hfyy5_0" on storage.objects;
create policy "users can update 13hfyy5_0" on storage.objects
  for update
  using (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "users can delete their own files 13hfyy5_0" on storage.objects;
create policy "users can delete their own files 13hfyy5_0" on storage.objects
  for delete
  using (
    bucket_id = 'receipt-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
