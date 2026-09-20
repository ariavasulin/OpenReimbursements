-- Intentional queue removal cancels the durable ordinary attempt, even when the
-- browser lost its lease-acquisition response. Finalize and cancel share its lock.
begin;
create or replace function public.photo_cancel_upload(p_actor uuid,p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.photo_upload_attempts;
begin
  perform public.photo_require_gate('writes'); perform public.photo_require_actor(p_actor);
  select * into a from public.photo_upload_attempts where id=p_attempt_id for update;
  if not found then raise exception 'not_found'; end if;
  if a.actor_id is distinct from p_actor then raise exception 'forbidden'; end if;
  if a.result is not null then return a.result; end if;
  if a.status='cancelled' then return jsonb_build_object('status','cancelled'); end if;
  perform pg_advisory_xact_lock(hashtextextended(a.content_sha256,0));
  update public.photo_upload_attempts set status='cancelled',lease_generation=lease_generation+1,
    lease_expires_at=null,updated_at=clock_timestamp() where id=a.id;
  delete from public.photo_content_claims where upload_attempt_id=a.id and actor_id=p_actor;
  return jsonb_build_object('status','cancelled');
end $$;
revoke all on function public.photo_cancel_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.photo_cancel_upload(uuid,uuid) to service_role;
commit;
