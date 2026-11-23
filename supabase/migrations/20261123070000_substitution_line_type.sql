-- ═══════════════════════════════════════════════════════════════════════════
-- Fix (2026-11-23): a substitute's payslip could not be saved. Part C writes a
-- payslip line of type 'substitution', but payroll_incentives_type_check (last
-- set in 20261109110000) did not list it, so payroll_commit_entries refused
-- that employee's payslip (type and traceability checks). Additive: the same lists plus 'substitution'.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type = ANY (ARRAY[
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload', 'subsidy',
  'subsidy_adjustment', 'early_bird_incentive', 'year_end_tax_refund', 'leave_conversion', 'substitution']));

-- And the traceability check (also last set in 20261109110000): a substitution line is traced to the
-- approved substitution (substitution_id in the payslip's audit), not to one attendance log.
ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_traceable_chk;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_traceable_chk CHECK (
  is_override
  OR type = ANY (ARRAY['incentive', 'overload', 'subsidy', 'subsidy_adjustment', 'year_end_tax_refund', 'leave_conversion', 'substitution'])
  OR source_log_id IS NOT NULL
  OR COALESCE(array_length(source_log_ids, 1), 0) > 0);
