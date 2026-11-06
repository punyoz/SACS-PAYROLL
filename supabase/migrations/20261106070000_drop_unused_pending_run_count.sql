-- Decision 2026-11-06: remove unused objects, safely.
--
-- public.payroll_pending_run_count() (20261014010000_payroll_run_approval)
-- returned the number of pending payroll runs. Checked
-- before removing, locally and on live: no application code, script, cron
-- job, view, RLS policy or other database function calls it, and only
-- service_role could execute it. A function holds no data.
--
-- The old migration that created it is left as it is.

DROP FUNCTION IF EXISTS public.payroll_pending_run_count();
