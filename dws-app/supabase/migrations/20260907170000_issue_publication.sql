begin;

-- A digest may coalesce many independent client keys; all remain bound forever.
create table if not exists public.issue_report_keys (
  client_key text primary key check(length(client_key) between 1 and 200),
  submission_id uuid not null references public.issue_report_submissions(id),
  payload_digest text not null check(payload_digest ~ '^[0-9a-f]{64}$')
);
alter table public.issue_report_keys enable row level security;
revoke all on public.issue_report_keys from public,anon,authenticated;
grant all on public.issue_report_keys to service_role;
insert into public.issue_report_keys(client_key,submission_id,payload_digest)
select client_key,id,payload_digest from public.issue_report_submissions where client_key is not null
on conflict(client_key) do nothing;

create or replace function public.issue_claim_submission(
  p_payload_digest text,p_payload jsonb,p_attribution jsonb,p_client_key text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.issue_report_submissions; k public.issue_report_keys; action text := 'none';
begin
  perform public.photo_require_gate('mcp');
  if p_payload_digest is null or p_payload_digest !~ '^[0-9a-f]{64}$' or
     jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_attribution) is distinct from 'object' or
     (p_client_key is not null and p_client_key !~ '^[A-Za-z0-9._:-]{1,200}$') then
    raise exception 'invalid_input';
  end if;
  if p_client_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('issue-key:'||p_client_key,0));
    select * into k from public.issue_report_keys where client_key=p_client_key;
    if found and k.payload_digest<>p_payload_digest then raise exception 'conflict'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('issue-digest:'||p_payload_digest,0));
  if k.submission_id is not null then
    select * into r from public.issue_report_submissions where id=k.submission_id for update;
  else
    select * into r from public.issue_report_submissions
    where payload_digest=p_payload_digest and
      (dedupe_expires_at>clock_timestamp() or status in ('pending','failed','publishing','unknown'))
    order by (status in ('publishing','unknown')) desc, created_at desc limit 1 for update;
  end if;
  if r.id is null then
    insert into public.issue_report_submissions(payload_digest,normalized_payload,attribution,client_key)
    values(p_payload_digest,p_payload,p_attribution,p_client_key) returning * into r;
  end if;
  if p_client_key is not null then
    insert into public.issue_report_keys values(p_client_key,r.id,p_payload_digest) on conflict do nothing;
  end if;
  if r.status='publishing' and (r.lease_expires_at is null or r.lease_expires_at<=clock_timestamp()) then
    -- Remote acceptance may have preceded process death. Never blindly resend.
    update public.issue_report_submissions set status='unknown',lease_expires_at=null,updated_at=clock_timestamp()
    where id=r.id returning * into r;
  end if;
  if r.status='pending' or
      (r.status='failed' and (r.error->>'retry_at' is null or (r.error->>'retry_at')::timestamptz<=clock_timestamp())) or
      (r.status='unknown' and (r.lease_expires_at is null or r.lease_expires_at<=clock_timestamp())) then
    action := case when r.status='unknown' then 'reconcile' else 'publish' end;
    update public.issue_report_submissions set
      status=case when action='publish' then 'publishing' else 'unknown' end,
      -- A remedied definitive rejection starts a new publication attempt, so
      -- fresh client keys must coalesce for 24 hours from that attempt too.
      -- Reconciliation only discovers an older send and preserves its horizon.
      dedupe_expires_at=case when r.status='failed' then clock_timestamp()+interval '24 hours' else dedupe_expires_at end,
      lease_generation=lease_generation+1,lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp(),error=null
    where id=r.id returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'lease_generation',r.lease_generation,'action',action,
    'issue_url',r.issue_url,'created_at',r.created_at,'payload',r.normalized_payload,'error',r.error);
end $$;

create or replace function public.issue_finish_submission(
  p_id uuid,p_generation bigint,p_status text,p_github_number bigint default null,p_issue_url text default null,p_error jsonb default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.issue_report_submissions;
begin
  -- Completion may record a known remote outcome after an operator closes MCP.
  select * into r from public.issue_report_submissions where id=p_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.lease_generation<>p_generation or r.lease_expires_at is null or r.lease_expires_at<=clock_timestamp() or
     r.status not in ('publishing','unknown') then raise exception 'stale_lease'; end if;
  if p_status is null or p_status not in ('published','failed','unknown') or (r.status='unknown' and p_status='failed') or
     (p_status='published' and (p_github_number is null or p_github_number<1 or
       p_issue_url is distinct from 'https://github.com/ariavasulin/OpenReimbursements/issues/'||p_github_number::text)) or
     (p_status<>'published' and (p_github_number is not null or p_issue_url is not null)) then raise exception 'invalid_input'; end if;
  update public.issue_report_submissions set status=p_status,github_number=p_github_number,issue_url=p_issue_url,
    error=p_error,lease_expires_at=null,updated_at=clock_timestamp() where id=p_id returning * into r;
  return jsonb_build_object('id',r.id,'status',r.status,'issue_url',r.issue_url,'error',r.error);
end $$;

revoke all on function public.issue_claim_submission(text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.issue_finish_submission(uuid,bigint,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.issue_claim_submission(text,jsonb,jsonb,text) to service_role;
grant execute on function public.issue_finish_submission(uuid,bigint,text,bigint,text,jsonb) to service_role;
commit;
