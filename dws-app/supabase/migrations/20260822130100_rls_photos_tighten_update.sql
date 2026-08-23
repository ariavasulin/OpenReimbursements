begin;

drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos
  for insert to authenticated
  with check (uploader_id = (select auth.uid()));

-- The row gate stays open; the column grants below carry the write rule
-- ("anyone signed in may fix a photo's job, sheet, or tags").
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
