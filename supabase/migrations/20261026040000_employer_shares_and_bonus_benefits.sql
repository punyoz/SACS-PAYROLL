-- Employer shares of the government contributions, and the Early Bird /
-- Perfect Attendance bonuses as tax-exempt "other benefits" (decisions of
-- 2026-10-26).
--
-- 1. Six new payroll rates, effective-dated like every other rate (the Super
--    Admin changes them; the Accountant and HR read them):
--      sss_er_pct         10    employer % of the SSS salary credit
--      sss_ec_low         10    EC (employer only) below the threshold
--      sss_ec_high        30    EC at or above the threshold
--      sss_ec_threshold   15000 salary credit where the higher EC starts
--      philhealth_er_pct  2.5   employer % of the PhilHealth base
--      pagibig_er_pct     2     employer % of the fund salary (cap ₱10,000)
--    Seeded from 2025-01-01 (RA 11199 schedule; PhilHealth 5% shared; HDMF
--    2% / 2%). The employer share is computed on each 2nd-half payslip and
--    kept at payroll.employer_contributions: never deducted from the
--    employee, never in gross, taxable income or net pay, never on the
--    employee's payslip; the remittance report adds it to the employee share.
--
-- 2. payroll_exempt_benefits_paid (the yearly ₱90,000 "13th month and other
--    benefits" ledger) also counts the Early Bird and Perfect Attendance
--    bonuses of Final semi-monthly payslips, by the payslip's period end.
--    Payroll then taxes a month's bonuses only above what is left of the
--    ceiling; the BIR 2316 reports them with the 13th month (boxes 34 / 48)
--    instead of as taxable other compensation (box 51B).
--
-- Additive. Safe to run more than once.

ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_rate_type_check;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_rate_type_check CHECK (rate_type IN (
  'hourly', 'daily', 'half_day_pct', 'absent_pct', 'late_days_per_absent',
  'late_minute_charge_pct', 'early_bird_bonus', 'perfect_attendance_bonus',
  'sss_pct', 'philhealth_pct', 'pagibig_pct',
  'overtime_premium_pct', 'regular_holiday_premium_pct', 'special_holiday_premium_pct',
  'sss_msc_min', 'sss_msc_max', 'philhealth_floor', 'philhealth_ceiling',
  'pagibig_max_salary', 'working_days_per_year',
  'attendance_lock_day', 'overload_premium_pct',
  'payroll_per_half', 'contribution_method', 'contribution_half',
  'sss_fixed', 'philhealth_fixed', 'pagibig_fixed', 'carry_after_lock',
  'benefits_exempt_ceiling',
  'sss_er_pct', 'sss_ec_low', 'sss_ec_high', 'sss_ec_threshold', 'philhealth_er_pct', 'pagibig_er_pct'
));

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT v.rate_type, 'global', NULL, v.value, DATE '2025-01-01', v.note, 'System default'
FROM (VALUES
  ('sss_er_pct',        10::NUMERIC,    'SSS employer share: 10% of MSC (RA 11199, 2025)'),
  ('sss_ec_low',        10::NUMERIC,    'SSS EC, employer only: MSC below ₱15,000'),
  ('sss_ec_high',       30::NUMERIC,    'SSS EC, employer only: MSC ₱15,000 and above'),
  ('sss_ec_threshold',  15000::NUMERIC, 'SSS EC: higher amount from this salary credit'),
  ('philhealth_er_pct', 2.5::NUMERIC,   'PhilHealth employer share: 2.5% (5% premium shared equally)'),
  ('pagibig_er_pct',    2::NUMERIC,     'Pag-IBIG employer share: 2% of fund salary (max ₱10,000)')
) AS v(rate_type, value, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c WHERE c.rate_type = v.rate_type AND c.scope = 'global'
);

-- Same columns as 20261009010000, plus the bonuses.
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
  -- Early Bird and Perfect Attendance bonuses of Final semi-monthly payslips.
  SELECT e.employee_id, EXTRACT(YEAR FROM x.period_end)::INTEGER, 'bonus',
         x.amount, x.period_end
  FROM public.payroll_entries e
  CROSS JOIN LATERAL (
    SELECT NULLIF(e.payroll -> 'audit' -> 'period' ->> 'end_key', '')::DATE AS period_end,
           NULLIF(e.payroll -> 'audit' -> 'period' ->> 'start_key', '')::DATE AS period_start,
           COALESCE((e.payroll -> 'totals' ->> 'early_bird_winner_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'perfect_attendance_incentive')::NUMERIC, 0) AS amount
  ) x
  WHERE e.status = 'paid' AND x.period_end IS NOT NULL AND x.period_start >= DATE '2026-10-01' AND x.amount > 0;

REVOKE ALL ON public.payroll_exempt_benefits_paid FROM anon, authenticated;
