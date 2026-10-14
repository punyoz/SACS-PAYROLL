-- ═══════════════════════════════════════════════════════════════════════════
-- Covering indexes for foreign keys, and one index nothing uses
-- ═══════════════════════════════════════════════════════════════════════════
--
-- From the Supabase performance advisor, health check of Oct 14, 2026.
--
-- 1. unindexed_foreign_keys: 24 foreign keys had no index starting with their
--    column, so deleting / updating the referenced row (or joining on it)
--    scans the whole referencing table. One plain btree index each.
--
-- 2. unused_index: of the 50 reported, 49 stay. 45 of them cover a foreign
--    key (dropping them would bring warning 1 back) and the rest serve
--    queries the app or the database functions run; they read as "unused"
--    only because those tables are new and still nearly empty.
--    audit_logs_actor_id_idx is the exception: nothing filters audit_logs by
--    actor_id (src/lib/audit/store.js reads newest first, by branch, and
--    applies every other filter in the app), and
--    audit_logs takes the most inserts of any table. Recreate with:
--      CREATE INDEX audit_logs_actor_id_idx ON public.audit_logs (actor_id, created_at DESC);
--
-- No data is changed. Safe to run more than once.

CREATE INDEX IF NOT EXISTS attendance_blocked_taps_branch_id_idx ON public.attendance_blocked_taps (branch_id);
CREATE INDEX IF NOT EXISTS attendance_blocked_taps_leave_request_id_idx ON public.attendance_blocked_taps (leave_request_id);
CREATE INDEX IF NOT EXISTS early_bird_winners_employee_id_idx ON public.early_bird_winners (employee_id);
CREATE INDEX IF NOT EXISTS employee_awol_cases_confirmed_by_idx ON public.employee_awol_cases (confirmed_by);
CREATE INDEX IF NOT EXISTS employee_awol_cases_decided_by_idx ON public.employee_awol_cases (decided_by);
CREATE INDEX IF NOT EXISTS employee_awol_cases_leave_request_id_idx ON public.employee_awol_cases (leave_request_id);
CREATE INDEX IF NOT EXISTS employee_awol_cases_recommended_by_idx ON public.employee_awol_cases (recommended_by);
CREATE INDEX IF NOT EXISTS employee_license_alerts_acknowledged_by_idx ON public.employee_license_alerts (acknowledged_by);
CREATE INDEX IF NOT EXISTS employee_license_changes_prc_id_document_id_idx ON public.employee_license_changes (prc_id_document_id);
CREATE INDEX IF NOT EXISTS employee_license_documents_uploaded_by_idx ON public.employee_license_documents (uploaded_by);
CREATE INDEX IF NOT EXISTS employee_status_changes_awol_case_id_idx ON public.employee_status_changes (awol_case_id);
CREATE INDEX IF NOT EXISTS leave_requests_cancelled_by_idx ON public.leave_requests (cancelled_by);
CREATE INDEX IF NOT EXISTS notifications_run_id_idx ON public.notifications (run_id);
CREATE INDEX IF NOT EXISTS payroll_loans_converted_to_loan_id_idx ON public.payroll_loans (converted_to_loan_id);
CREATE INDEX IF NOT EXISTS payroll_loans_decision_approved_by_idx ON public.payroll_loans (decision_approved_by);
CREATE INDEX IF NOT EXISTS payroll_loans_decision_recommended_by_idx ON public.payroll_loans (decision_recommended_by);
CREATE INDEX IF NOT EXISTS payroll_run_items_entry_id_idx ON public.payroll_run_items (entry_id);
CREATE INDEX IF NOT EXISTS payroll_runs_processed_by_idx ON public.payroll_runs (processed_by);
CREATE INDEX IF NOT EXISTS payroll_runs_reviewed_by_idx ON public.payroll_runs (reviewed_by);
CREATE INDEX IF NOT EXISTS payroll_runs_submitted_by_idx ON public.payroll_runs (submitted_by);
CREATE INDEX IF NOT EXISTS payroll_subsidy_adjustments_decided_by_idx ON public.payroll_subsidy_adjustments (decided_by);
CREATE INDEX IF NOT EXISTS payroll_subsidy_adjustments_requested_by_idx ON public.payroll_subsidy_adjustments (requested_by);
CREATE INDEX IF NOT EXISTS profiles_license_verified_by_idx ON public.profiles (license_verified_by);
CREATE INDEX IF NOT EXISTS profiles_prc_id_document_id_idx ON public.profiles (prc_id_document_id);

DROP INDEX IF EXISTS public.audit_logs_actor_id_idx;
