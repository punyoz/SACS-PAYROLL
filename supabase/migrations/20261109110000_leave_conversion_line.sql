-- Unused leave conversion in final pay (decision 2026-11-09 #1): OFF until
-- the school confirms its rule; HR or the Super Admin can switch it on later
-- (system_config payroll.leave_conversion_enabled / leave_conversion_max_days,
-- written through /api/payroll/leave-conversion, audited). When it is on, the
-- final payslip carries one more income line, type 'leave_conversion'.
--
-- This adds that type to the two CHECK constraints of payroll_incentives
-- (same lists as before plus 'leave_conversion'). No row is changed. The
-- constraints are swapped inside one transaction; the new ones are validated
-- against the existing rows, which all satisfy the old, narrower lists.
-- Safe to run more than once.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_incentives'::regclass AND conname = 'payroll_incentives_type_check'
      AND pg_get_constraintdef(oid) LIKE '%leave_conversion%'
  ) THEN
    ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
    ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type = ANY (ARRAY[
      'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload', 'subsidy',
      'subsidy_adjustment', 'early_bird_incentive', 'year_end_tax_refund', 'leave_conversion']));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_incentives'::regclass AND conname = 'payroll_incentives_traceable_chk'
      AND pg_get_constraintdef(oid) LIKE '%leave_conversion%'
  ) THEN
    ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_traceable_chk;
    ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_traceable_chk CHECK (
      is_override
      OR type = ANY (ARRAY['incentive', 'overload', 'subsidy', 'subsidy_adjustment', 'year_end_tax_refund', 'leave_conversion'])
      OR source_log_id IS NOT NULL
      OR COALESCE(array_length(source_log_ids, 1), 0) > 0);
  END IF;
END $$;
