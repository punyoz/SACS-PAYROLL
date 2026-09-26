-- ═══════════════════════════════════════════════════════════════════════════
-- Hardening for the attendance / payroll-rate functions (Supabase advisor)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. A fixed search_path on the helpers that did not set one, so a caller's
--    search_path can never redirect the names they use.
-- 2. The status engine's trigger function and its schedule lookup are
--    SECURITY DEFINER and were callable through the REST API
--    (/rest/v1/rpc/...) by anon and signed-in users. Nothing calls them that
--    way: the trigger fires regardless of EXECUTE (it is only checked when a
--    trigger is created), and attendance_policy_for() is called from inside
--    that trigger function, which runs as its owner.
--
-- The other functions the application calls (attendance_close_days,
-- attendance_request_correction, attendance_review_correction,
-- attendance_resolve_record, attendance_correct_absence) were already limited
-- to service_role when they were created.
--
-- Safe to run more than once.

ALTER FUNCTION public.attendance_hhmm_to_minutes(TEXT) SET search_path = public;
ALTER FUNCTION public.attendance_to_number(TEXT) SET search_path = public;
ALTER FUNCTION public.payroll_rate_configs_append_only() SET search_path = public;

REVOKE ALL ON FUNCTION public.attendance_logs_compute_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_policy_for(UUID) FROM PUBLIC, anon, authenticated;
