-- Prevent concurrent payroll submissions from creating two payroll_entries
-- rows for the same employee + pay period. Before this, two near-simultaneous
-- "submit" requests for the same employee/period could each pass the app's
-- in-memory duplicate check (both reading the table before either had
-- written), producing two payroll_records rows — i.e. the employee getting
-- paid twice for one period — while payroll_entries itself only ever kept one
-- of the two (whichever write landed last).
--
-- payroll_entries holds at most one draft/pending/paid row per employee per
-- pay period by design (see the app's hasDraftDuplicate/hasAlreadyPaid
-- checks); the durable, append-only paid record lives in payroll_records
-- instead (its own payslip_no already carries a UNIQUE constraint — see
-- 20260509010000_add_payslip_no.sql), so collapsing any pre-existing duplicate
-- payroll_entries rows down to the most recently updated one loses no payroll
-- history.

-- 1. Collapse any duplicates that already exist (keep the most recently
--    updated row per employee_id + pay_period; ties broken by id).
DELETE FROM public.payroll_entries a
USING public.payroll_entries b
WHERE a.employee_id = b.employee_id
  AND a.pay_period = b.pay_period
  AND a.employee_id IS NOT NULL
  AND a.pay_period IS NOT NULL
  AND (
    a.updated_at < b.updated_at
    OR (a.updated_at = b.updated_at AND a.id < b.id)
  );

-- 2. Drop the old non-unique index — superseded by the UNIQUE constraint
--    below, which creates its own backing index.
DROP INDEX IF EXISTS public.payroll_entries_employee_period_idx;

-- 3. Enforce the invariant at the database level, and give the app an
--    ON CONFLICT target to upsert against instead of the previous
--    delete-then-insert (which had its own race window).
--    Guarded so the file can be run again.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_entries_employee_period_unique') THEN
    ALTER TABLE public.payroll_entries
      ADD CONSTRAINT payroll_entries_employee_period_unique UNIQUE (employee_id, pay_period);
  END IF;
END;
$$;
