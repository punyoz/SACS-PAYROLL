-- ═══════════════════════════════════════════════════════════════════════════
-- Cash advances moved to Loans: payroll_cash_advances becomes read-only history
-- (docs/payroll-schedule-loans-awol.md §8 Part B, decision 5).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run after scripts/migrate-cash-advances-to-loans.mjs (on 2026-10-09 the live
-- table was empty, so there was nothing to move). Old payslips keep their
-- cash_advance lines; reads still work. Safe to run more than once.

CREATE OR REPLACE FUNCTION public.payroll_cash_advances_read_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Cash advances moved to Loans: payroll_cash_advances is read-only history.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.payroll_cash_advances_read_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_cash_advances_read_only ON public.payroll_cash_advances;
CREATE TRIGGER payroll_cash_advances_read_only
  BEFORE INSERT OR UPDATE ON public.payroll_cash_advances
  FOR EACH ROW EXECUTE FUNCTION public.payroll_cash_advances_read_only();
-- Deletes are already blocked by payroll_cash_advances_block_hard_delete.
