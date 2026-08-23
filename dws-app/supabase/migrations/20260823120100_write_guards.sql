-- 1. receipts.status may only be changed by an admin session or the service
--    role. RLS WITH CHECK cannot see the pre-update row, and a column grant
--    would also block the admin routes, which write status through the
--    caller's session — so a BEFORE UPDATE trigger carries the rule. The
--    function is security invoker, so current_user is the caller, not the
--    definer.
--
-- 2. user_profiles INSERT: a signed-in caller may create their own row, as an
--    employee. The signup trigger runs as the table owner and the admin routes
--    use the service role, so neither is affected.

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
