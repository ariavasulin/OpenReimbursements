-- Two write-authorization gaps in the same class as 20260823100000 §2, which
-- moved user_profiles.role out of reach of the UPDATE path but stopped there.
--
-- 1. receipts.status: `authenticated` holds table-wide UPDATE on receipts and
--    receipts_update is `user_id = (select auth.uid())`, so an employee could
--    PATCH their own Pending receipt to Approved — through the API route (which
--    only checked ownership and Pending) or directly over PostgREST. RLS
--    WITH CHECK cannot see the pre-update row, and a column grant would also
--    block the admin routes, which write status through the caller's session.
--    A BEFORE UPDATE trigger can see both rows and who is asking.
--
--    Allowed to change status: an admin session (is_admin()) and the service
--    role (current_user is the role PostgREST switched to; the trigger
--    function is security invoker so current_user is the caller, not the
--    definer). The admin writers today — PATCH /api/receipts as admin,
--    /api/receipts/batch-status, /api/receipts/bulk-update — all run as admin
--    sessions.
--
-- 2. user_profiles INSERT: `authenticated` holds table-wide INSERT and
--    user_profiles_insert_policy only required a signed-in caller, so a row
--    {user_id: <any id without a profile>, role: 'admin'} was insertable.
--    Reachability needed an auth.users id with no profile row (the signup
--    trigger creates one), but the policy should say what the app means: you
--    may create your own row, as an employee. The signup trigger runs as the
--    table owner and the admin routes use the service role, so neither is
--    affected. PATCH /api/profile inserts {user_id: self, role: 'employee'}.

create or replace function public.receipts_guard_status_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and current_user <> 'service_role'
     and not public.is_admin() then
    raise exception 'only an admin can change a receipt''s status'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.receipts_guard_status_change() is
  'BEFORE UPDATE guard on public.receipts: a status change must come from an admin session (public.is_admin()) or the service role.';

drop trigger if exists receipts_guard_status_change on public.receipts;
create trigger receipts_guard_status_change
  before update of status on public.receipts
  for each row execute function public.receipts_guard_status_change();

drop policy if exists user_profiles_insert_policy on public.user_profiles;
create policy user_profiles_insert_policy on public.user_profiles
  for insert
  with check (
    user_id = (select auth.uid())
    and role = 'employee'
  );
