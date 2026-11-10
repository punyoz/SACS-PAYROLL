-- The three guard trigger functions added on 2026-11-10 are not API calls:
-- nobody may call them by /rest/v1/rpc (the security advisor flagged them).
-- Triggers still fire: EXECUTE is checked when a trigger is created, not
-- when it runs. Idempotent.
REVOKE ALL ON FUNCTION public.attendance_taps_duplicate_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leave_requests_decision_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_entries_self_processing_guard() FROM PUBLIC, anon, authenticated;
