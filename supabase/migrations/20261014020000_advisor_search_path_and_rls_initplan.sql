-- ═══════════════════════════════════════════════════════════════════════════
-- Advisor fixes for 20261014010000_payroll_run_approval.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by the Supabase advisors in the health check of Oct 14, 2026.
-- Nothing is dropped; definitions are changed in place.
--
-- 1. function_search_path_mutable (security, WARN): four helper functions
--    had no fixed search_path, so a caller's search_path could change which
--    objects they resolve. Pinned to public, like every other function.
--
-- 2. auth_rls_initplan (performance, WARN): three policies called auth.uid()
--    once per row. Wrapped as (SELECT auth.uid()) so Postgres evaluates it
--    once per query. The rules themselves are unchanged.
--
-- Safe to run more than once.

ALTER FUNCTION public.payroll_approval_effective() SET search_path = public;
ALTER FUNCTION public.payroll_period_label(DATE) SET search_path = public;
ALTER FUNCTION public.payroll_period_requires_approval(TEXT) SET search_path = public;
ALTER FUNCTION public.payroll_run_action_on() SET search_path = public;

ALTER POLICY notifications_own_read ON public.notifications
  USING (recipient_id = (SELECT auth.uid()));

ALTER POLICY notifications_own_mark_read ON public.notifications
  USING (recipient_id = (SELECT auth.uid()))
  WITH CHECK (recipient_id = (SELECT auth.uid()));

ALTER POLICY payroll_entries_own_after_approval ON public.payroll_entries
  USING (
    employee_id = (SELECT auth.uid())
    AND status::TEXT <> 'draft'
    AND (
      NOT public.payroll_period_requires_approval(pay_period)
      OR EXISTS (
        SELECT 1 FROM public.payroll_runs r
        WHERE r.id = payroll_entries.run_id AND r.status = 'approved'
      )
    )
  );
