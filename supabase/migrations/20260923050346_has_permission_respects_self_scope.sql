-- ════════════════════════════════════════════════════════════════════════════
-- has_permission() must honour role_permissions.scope, not just the action flag
--
-- The function read only can_create/can_read/can_update/can_delete and ignored
-- the `scope` column entirely. But every policy that calls it pairs it with
-- can_reach_branch() as the WIDE clause -- "may this role reach OTHER people's
-- rows in its branch?" -- while self-access is always expressed separately as
-- id / employee_id / user_id = auth.uid(). A row with scope='self' was
-- therefore being read as a branch-wide grant.
--
-- WHAT THIS LET THROUGH
-- Employee holds employee_information(scope='self', can_read=true), which made
-- the second clause of profiles_select_branch true for every profile sharing
-- the Employee's branch. Measured: the Employee account read 4 profiles -- its
-- own plus the HR, Admin and Accountant rows, bank_account_number, sss_number,
-- philhealth_number, address and cp_number included. The matrix (row 4) gives
-- Employee "V (own profile only)". After this change: 1 row.
--
-- The same latent grant sat on two more tables, neither of which had rows yet:
--   * attendance_logs  -- employee attendance(scope='self')      -> branch-wide
--   * leave_requests   -- employee leave_approval(scope='self')  -> branch-wide
--
-- WHY NOTHING LOSES ITS OWN ROWS
-- All 16 policies calling has_permission() were checked one by one: each pairs
-- it with can_reach_branch() and carries its own auth.uid() self clause. No
-- policy relies on a scope='self' grant to hand someone their own record, so
-- returning false for 'self' removes reach over others and nothing else.
-- Verified after: Employee 1 profile / 4 payroll rows (all its own) / 0 audit;
-- HR, Accountant, Admin and Super Admin counts all unchanged.
--
-- scope='none' already returned false through the action flags, and still does.
--
-- Idempotent (CREATE OR REPLACE). Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.has_permission(target_module TEXT, target_action TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE
             -- A self-scoped grant conveys no reach over anyone else's rows.
             WHEN LOWER(COALESCE(scope, 'none')) = 'self' THEN false
             ELSE CASE LOWER(target_action)
                    WHEN 'create' THEN can_create
                    WHEN 'read'   THEN can_read
                    WHEN 'update' THEN can_update
                    WHEN 'delete' THEN can_delete
                    ELSE false
                  END
           END
    FROM public.role_permissions
    WHERE role = public.current_role_name()
      AND module = target_module
  ), false);
$$;
