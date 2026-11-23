-- ═══════════════════════════════════════════════════════════════════════════
-- Honorarium, Bonus and Adjustment (panel item "adjustment / honorarium /
-- bonus / incentives", 2026-11-23). They reuse payroll_monthly_incentives:
-- the Accountant files, HR approves (payroll_adjustment_decide, preset
-- remarks, never their own), payroll pays approved ones as their own lines.
--   honorarium   taxable compensation (amount > 0)
--   bonus        "other benefits": exempt with the 13th month up to the yearly
--                ceiling (₱90,000), taxable above it (amount > 0; counted in
--                payroll_exempt_benefits_paid)
--   adjustment   + or − (amount <> 0), a reason required; taxable unless
--                non_taxable (a correction of a non-taxable item)
-- Additive: two columns, wider checks, the benefits view with one more term.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.payroll_monthly_incentives ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE public.payroll_monthly_incentives ADD COLUMN IF NOT EXISTS non_taxable BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
DECLARE r RECORD;
BEGIN
  -- The auto-named column check on kind.
  FOR r IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.payroll_monthly_incentives'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%overload%'
             AND conname <> 'payroll_monthly_incentives_value_chk' LOOP
    EXECUTE format('ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_kind_check
  CHECK (kind IN ('incentive', 'overload', 'honorarium', 'bonus', 'adjustment'));

ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_value_chk;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_value_chk CHECK (
  (kind IN ('incentive', 'honorarium', 'bonus') AND amount > 0 AND hours IS NULL)
  OR (kind = 'overload' AND hours > 0 AND amount IS NULL)
  OR (kind = 'adjustment' AND amount <> 0 AND hours IS NULL AND char_length(btrim(COALESCE(reason, ''))) >= 5)
);
ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_non_taxable_chk;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_non_taxable_chk
  CHECK (NOT non_taxable OR kind = 'adjustment');

-- The yearly "13th month and other benefits" ledger: bonus items of Final payslips join the bonuses.
CREATE OR REPLACE VIEW public.payroll_exempt_benefits_paid
WITH (security_invoker = true) AS
  SELECT t.employee_id, t.year AS tax_year, 'thirteenth_month'::TEXT AS kind,
         t.amount, t.processed_at::DATE AS paid_on
  FROM public.payroll_thirteenth_month t
  UNION ALL
  SELECT l.employee_id, EXTRACT(YEAR FROM l.date_granted)::INTEGER, 'subsidy_advance',
         l.principal, l.date_granted
  FROM public.payroll_loans l
  JOIN public.payroll_subsidy_balances b ON b.id = l.subsidy_balance_id
  WHERE l.loan_type = 'subsidy_advance' AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT b.employee_id, EXTRACT(YEAR FROM b.paid_out_on)::INTEGER, 'subsidy_payout',
         b.paid_out, b.paid_out_on
  FROM public.payroll_subsidy_balances b
  WHERE b.paid_out > 0 AND b.paid_out_on IS NOT NULL AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT a.employee_id, EXTRACT(YEAR FROM a.applied_at)::INTEGER, 'subsidy_adjustment',
         a.amount, a.applied_at::DATE
  FROM public.payroll_subsidy_adjustments a
  JOIN public.payroll_subsidy_balances b ON b.id = a.subsidy_balance_id
  WHERE a.status = 'applied' AND b.tax_treatment = 'other_benefit'
  UNION ALL
  -- Early Bird and Perfect Attendance bonuses, and bonus items (2026-11-23), of Final semi-monthly payslips.
  SELECT e.employee_id, EXTRACT(YEAR FROM x.period_end)::INTEGER, 'bonus',
         x.amount, x.period_end
  FROM public.payroll_entries e
  CROSS JOIN LATERAL (
    SELECT NULLIF(e.payroll -> 'audit' -> 'period' ->> 'end_key', '')::DATE AS period_end,
           NULLIF(e.payroll -> 'audit' -> 'period' ->> 'start_key', '')::DATE AS period_start,
           COALESCE((e.payroll -> 'totals' ->> 'early_bird_winner_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'perfect_attendance_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'bonus_items')::NUMERIC, 0) AS amount
  ) x
  WHERE e.status = 'paid' AND x.period_end IS NOT NULL AND x.period_start >= DATE '2026-10-01' AND x.amount > 0;

REVOKE ALL ON public.payroll_exempt_benefits_paid FROM anon, authenticated;
