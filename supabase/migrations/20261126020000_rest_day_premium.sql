-- 2026-11-26: rest-day premium (Labor Code Art. 93: work on a rest day is 130 %).
-- Adds the rate type `rest_day_premium_pct` to the allowed list and its global
-- default (30). Overtime and substitutions on an employee's rest day that is not
-- a holiday are paid at the hourly rate x (100 + this) %; holidays keep their rates.
-- Additive: the list below is the live list plus the new type.
ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_rate_type_check;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_rate_type_check CHECK (rate_type IN (
  'hourly', 'daily', 'half_day_pct', 'absent_pct', 'late_days_per_absent',
  'late_minute_charge_pct', 'early_bird_bonus', 'perfect_attendance_bonus',
  'sss_pct', 'philhealth_pct', 'pagibig_pct',
  'overtime_premium_pct', 'regular_holiday_premium_pct', 'special_holiday_premium_pct',
  'sss_msc_min', 'sss_msc_max', 'philhealth_floor', 'philhealth_ceiling',
  'pagibig_max_salary', 'working_days_per_year', 'attendance_lock_day',
  'overload_premium_pct', 'payroll_per_half', 'contribution_method', 'contribution_half',
  'sss_fixed', 'philhealth_fixed', 'pagibig_fixed', 'carry_after_lock',
  'benefits_exempt_ceiling', 'sss_er_pct', 'sss_ec_low', 'sss_ec_high', 'sss_ec_threshold',
  'philhealth_er_pct', 'pagibig_er_pct',
  'rest_day_premium_pct'
));

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT 'rest_day_premium_pct', 'global', NULL, 30, DATE '2025-01-01',
       'Rest day premium: work on a rest day is 130% (Labor Code Art. 93)', 'System default'
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs WHERE rate_type = 'rest_day_premium_pct' AND scope = 'global'
);
