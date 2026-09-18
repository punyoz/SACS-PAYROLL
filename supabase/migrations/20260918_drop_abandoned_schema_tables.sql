-- Drop the remaining tables from the abandoned pre-Supabase-Auth schema design
-- that 20260830_drop_payroll_entries_employee_fk.sql already identified by name
-- as dead: "employees" (alongside payroll_periods, payslips, attendance,
-- approval_logs, employees_branch_* -- none of which any code in this repo
-- reads or writes). employees_branch_* and salary_approvals were already
-- dropped separately; this finishes the cleanup for the rest.
--
-- This app identifies people by their Supabase Auth user UUID (via
-- profiles/auth.users) and records attendance/payroll through
-- attendance_logs/payroll_records/payroll_entries instead, so none of these
-- five ever had a live code path reading or writing them.
--
-- Verified empty (or holding only stale test data) via the live project's
-- REST API immediately before writing this migration:
--   employees: 0 rows, attendance: 0 rows, payslips: 0 rows,
--   approval_logs: 0 rows, payroll_periods: 1 stale test row ("March 2026").
--
-- CASCADE drops each table's own indexes, RLS policies, and triggers; no
-- other table has a foreign key into any of these five.
DROP TABLE IF EXISTS public.employees CASCADE;
DROP TABLE IF EXISTS public.attendance CASCADE;
DROP TABLE IF EXISTS public.payslips CASCADE;
DROP TABLE IF EXISTS public.approval_logs CASCADE;
DROP TABLE IF EXISTS public.payroll_periods CASCADE;
