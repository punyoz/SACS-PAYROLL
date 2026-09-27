-- ═══════════════════════════════════════════════════════════════════════════
-- Drop indexes nothing queries; add the one the attendance reads need
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Supabase advisor listed 34 indexes with zero scans. Most of them back a
-- foreign key: those stay, because without them a join or a parent-row check
-- scans the whole child table, and the advisor then flags "unindexed foreign
-- key" instead. They read as unused only because the tables are still small.
--
-- Dropped here are the ones no query in the app or the database functions
-- can use (every write pays to maintain an index):
--
--   attendance_logs_status_date_idx  (status, log_date): the date-range reads
--                                    filter on log_date alone, which a
--                                    status-first index cannot serve
--   audit_logs_module_idx,
--   audit_logs_action_idx            module/action filtering happens after the
--                                    query, never in SQL
--   idx_payroll_entries_period       payroll_period_id is never filtered on
--   payroll_records_period_label_idx period_label is never filtered on alone
--                                    (the (employee_id, period_label) unique
--                                    index covers the lookups)
--   profiles_archived_idx,
--   profiles_role_idx                five roles / two states across a small
--                                    table: never selective enough to use
--   profiles_employee_id_idx         duplicate of profiles_employee_id_unique
--   transfer_requests_status_idx     status is never filtered on in SQL
--
-- Kept although unused so far: leave_requests_status_idx (payroll now reads
-- approved leave by status), and the two indexes 20260927 added for the new
-- history and audit-actor lookups.
--
-- Added: attendance_logs (log_date). The status board, reports, payroll and
-- the day close all read attendance by date across every employee; the only
-- date-bearing index led with employee_id.
--
-- Safe to run more than once.

DROP INDEX IF EXISTS public.attendance_logs_status_date_idx;
DROP INDEX IF EXISTS public.audit_logs_module_idx;
DROP INDEX IF EXISTS public.audit_logs_action_idx;
DROP INDEX IF EXISTS public.idx_payroll_entries_period;
DROP INDEX IF EXISTS public.payroll_records_period_label_idx;
DROP INDEX IF EXISTS public.profiles_archived_idx;
DROP INDEX IF EXISTS public.profiles_role_idx;
DROP INDEX IF EXISTS public.profiles_employee_id_idx;
DROP INDEX IF EXISTS public.transfer_requests_status_idx;

CREATE INDEX IF NOT EXISTS attendance_logs_log_date_idx
  ON public.attendance_logs (log_date);
