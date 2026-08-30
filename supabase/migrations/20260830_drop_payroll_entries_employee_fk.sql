-- payroll_entries.employee_id carries a foreign key to a table named
-- "employees" that is a leftover from an earlier, abandoned schema design
-- (alongside payroll_periods, payslips, attendance, approval_logs,
-- employees_branch_* — none of which any code in this repo reads or writes).
-- This app identifies employees by their Supabase Auth user UUID (via
-- profiles/auth.users), which never has a matching row in that dead
-- "employees" table. The result: every payroll submission's insert into
-- payroll_entries has been silently failing with a foreign key violation
-- (23503), which is why Payslips/Payroll Records/Payroll Monitoring never
-- showed processed payroll even though "Payroll Processed" succeeded and a
-- payslip_no was generated (that part writes to payroll_records, which has
-- no such constraint).
--
-- Confirmed live via a direct test insert against the project's REST API:
--   insert or update on table "payroll_entries" violates foreign key
--   constraint "payroll_entries_employee_id_fkey"
--   Key (employee_id)=(...) is not present in table "employees".
--
-- Guarded so it's safe to run whether the constraint exists under this name
-- or not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_entries_employee_id_fkey'
  ) THEN
    ALTER TABLE public.payroll_entries DROP CONSTRAINT payroll_entries_employee_id_fkey;
  END IF;
END;
$$;
