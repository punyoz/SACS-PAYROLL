-- readPayrollEntries() in src/app/api/accountant/payroll/route.js orders
-- payroll_entries by updated_at on nearly every GET/POST/PATCH to this route,
-- but no index existed on that column (only status, (employee_id, pay_period),
-- and branch_id are indexed — see 20260512020000_add_payroll_entries.sql and
-- 20260903010000_rbac_branch_scoping.sql). As the table grows — every employee x
-- every pay period, retained indefinitely — this forces a full-table sort on
-- every payroll page load.
CREATE INDEX IF NOT EXISTS payroll_entries_updated_at_idx
  ON public.payroll_entries (updated_at DESC);
