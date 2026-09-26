-- ═══════════════════════════════════════════════════════════════════════════
-- Trigger functions are not API endpoints (Supabase advisor)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- These SECURITY DEFINER functions return `trigger` and run only from their
-- triggers:
--
--   apply_transfer_request_approval      transfer_requests
--   stamp_branch_from_employee           attendance_logs, payroll_records,
--                                        payroll_entries, leave_requests
--   sync_profile_branch_from_assignment  employee_branch_assignments
--
-- They were still listed as callable through /rest/v1/rpc by anon and
-- signed-in users. Postgres refuses to run a trigger function outside a
-- trigger, so this changes no behaviour; it only removes the exposure. The
-- triggers keep firing: EXECUTE is checked when a trigger is created, not
-- each time it fires.
--
-- Deliberately NOT revoked: is_super_admin, current_role_name,
-- current_branch_id, get_user_role, has_permission and can_reach_branch. The
-- row-level security policies call them as the signed-in user, so those roles
-- must keep EXECUTE.
--
-- Safe to run more than once.

REVOKE ALL ON FUNCTION public.apply_transfer_request_approval() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stamp_branch_from_employee() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_profile_branch_from_assignment() FROM PUBLIC, anon, authenticated;
