begin;

drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos
  for insert to authenticated
  with check (uploader_id = (select auth.uid()));

-- The product rule is "anyone signed in may fix a photo's job, sheet, or tags".
-- The previous policy implemented that as
-- `using (true) with check (true)`, which also let any signed-in user rewrite
-- uploader_id, original_path, thumb_path, preview_path, kind, and captured_at
-- on any row via a direct PostgREST call with the anon key. Column-level grants
-- express the actual rule; the policy then only has to gate the row.
drop policy if exists photos_update on public.photos;
create policy photos_update on public.photos
  for update to authenticated using (true) with check (true);

revoke update on public.photos from authenticated;
grant update (job_id, sheet_number, tags) on public.photos to authenticated;

drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos
  for delete to authenticated
  using (uploader_id = (select auth.uid()) or (select public.is_admin()));

commit;
