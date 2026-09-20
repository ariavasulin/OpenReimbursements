begin;

-- The HTTP key authenticates the caller; only the service role can issue this capability.
-- Recheck the release gate at the durable mutation boundary as well as on every MCP request.
create or replace function public.create_dws_handoff(
  p_token_digest text, p_script_name text, p_requested_input jsonb
) returns timestamptz language plpgsql security definer set search_path=public,pg_temp as $$
declare expires timestamptz;
begin
  perform public.photo_require_gate('mcp');
  if p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$'
    or p_script_name is null or p_script_name not in ('migrate_photos','add_photos','move_photos','remove_photos','restore_photos')
    or p_requested_input is null or jsonb_typeof(p_requested_input)<>'object'
    or octet_length(p_requested_input::text)>65536
  then raise exception 'invalid_input'; end if;
  expires:=clock_timestamp()+interval '30 minutes';
  insert into public.dws_action_handoffs(token_digest,script_name,requested_input,expires_at)
    values(p_token_digest,p_script_name,p_requested_input,expires);
  return expires;
end $$;
revoke all on function public.create_dws_handoff(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_dws_handoff(text,text,jsonb) to service_role;

commit;
