-- DWS Photos: storage SELECT/UPDATE policies for the `photos` bucket.
-- Uploads use upsert (insert-or-update), so Storage evaluates SELECT and UPDATE
-- policies even for a brand-new object; without these, every upload fails RLS.
-- Same own-prefix rule as photos_storage_insert in photos-schema.sql (which also
-- contains these statements — this file exists so the live project can be patched
-- without re-running the whole schema). Additive: no existing policy is altered.
--
-- Apply to production:
--   env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --project-ref qebbmojnqzwwdpkhuyyd -f dws-app/db/photos-storage-policies.sql

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
