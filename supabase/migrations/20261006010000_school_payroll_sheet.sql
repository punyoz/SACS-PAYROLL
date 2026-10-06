-- ═══════════════════════════════════════════════════════════════════════════
-- The school's payroll sheet: each half paid on its own attendance, fixed
-- SSS / PhilHealth / Pag-IBIG amounts, cash advances, and the sheet's header
-- (src/lib/payroll/school-sheet.js, src/lib/payroll/cash-advance.js)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20261003010000_semi_monthly_payroll.sql (it uses that file's
-- payroll_contribution_amounts and payroll_monthly_incentives tables).
--
-- The school pays two payslips a month:
--   1-15    the full Rate (monthly ÷ 2), nothing deducted;
--   16-end  every deduction of the month: days missed (Daily = Rate ÷ 12),
--           SSS, PhilHealth, Pag-IBIG, tax and cash advances.
-- That is the semi-monthly rule of 20261003010000 ("the 2nd half settles the
-- month"); this file adds the school's own amounts and cash advances to it.
--
-- Attendance: the 16-end payslip deducts the attendance read up to the 15th
-- (attendance_lock_day = 15, carry_after_lock = 1). October 16-31 deducts
-- October 1-15 (the first month starts on the 1st); November 16-30 deducts
-- October 16 - November 15; and so on. Leave and incentives dated or filed
-- after the 15th move to next month the same way.
--
-- 1. New effective-dated rates (Super Admin → Payroll Rates):
--      payroll_per_half      0 (the school's way) = the 1st half pays Rate
--                            with no deductions and the 2nd half settles the
--                            month. 1 = each half paid on its own attendance
--                            instead (kept as an option, off). Read on the 1st
--                            of the month, so both halves use one rule.
--      contribution_method   0 = SSS / PhilHealth / Pag-IBIG from the legal
--                            tables; 1 = the fixed amounts below.
--      sss_fixed, philhealth_fixed, pagibig_fixed
--                            fixed MONTHLY amounts (₱) when the method is 1.
--                            Per-employee amounts (Contribution Amounts, 0 =
--                            exempt) still win over these.
--      carry_after_lock      1 = absences, lates and leave without pay after
--                            the attendance lock day are deducted on next
--                            month's 16-end payslip (the school); 0 = they
--                            are never deducted, and each month reads its own
--                            1st to the lock day.
--      contribution_half     only with payroll_per_half on: which payslip
--                            deducts contributions (1 = 1st half, 2 = 2nd
--                            half, 3 = half on each). With it off they are
--                            always on the 16-end payslip.
-- 2. Starting values, from 2026-10-01: the school's sheet (₱400 SSS, ₱200
--    Pag-IBIG, no PhilHealth, Daily = monthly ÷ 24, late not deducted,
--    attendance locked on the 15th). The
--    October 16-31 payslip settles the month against what October 1-15
--    actually paid, so nothing is deducted twice. Change any of them in
--    Super Admin → Payroll Rates.
-- 3. payroll_cash_advances: a cash advance and its installment. What has been
--    repaid is read from the Final payslips themselves (payroll_entries
--    .payroll -> cash_advances), so a payslip and its repayment can never
--    disagree, and an overridden payslip replaces its repayment.
-- 4. Payslip line type 'cash_advance'.
-- 5. The payroll sheet's header and "Approved for payment" block
--    (system_config, section "payroll").
--
-- Safe to run more than once.

-- ── 1. Rates ───────────────────────────────────────────────────────────────

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
  'sss_fixed', 'philhealth_fixed', 'pagibig_fixed', 'carry_after_lock'
));

ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_switch_chk;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_switch_chk CHECK (
  rate_type NOT IN ('payroll_per_half', 'contribution_method', 'carry_after_lock') OR value IN (0, 1)
);

ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_half_chk;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_half_chk CHECK (
  rate_type <> 'contribution_half' OR value IN (1, 2, 3)
);

-- ── 2. Starting values ─────────────────────────────────────────────────────

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT v.rate_type, 'global', NULL, v.value, v.effective_date, v.note, 'System (school payroll sheet)'
FROM (VALUES
  ('payroll_per_half',     0::NUMERIC, DATE '2026-10-01', 'School: 1-15 pays the full Rate, 16-end deducts everything'),
  ('contribution_method',  1,   DATE '2026-10-01', 'School sheet: fixed amounts'),
  ('sss_fixed',            400, DATE '2026-10-01', 'School sheet: SSS ₱400 a month'),
  ('philhealth_fixed',     0,   DATE '2026-10-01', 'School sheet: no PhilHealth deduction'),
  ('pagibig_fixed',        200, DATE '2026-10-01', 'School sheet: Pag-IBIG ₱200 a month'),
  ('contribution_half',    2,   DATE '2026-10-01', 'School sheet: deducted on the 16-end payslip'),
  ('working_days_per_year', 24, DATE '2026-10-01', 'School sheet: Daily = monthly ÷ 24 (Rate ÷ 12)'),
  ('late_days_per_absent', 0,   DATE '2026-10-01', 'School sheet: late is not deducted'),
  ('attendance_lock_day',  15,  DATE '2026-10-01', 'School: the 16-end payslip deducts the attendance of the 1st to the 15th'),
  ('carry_after_lock',     1,   DATE '2026-10-01', 'School: days after the 15th are deducted on next month''s 16-end payslip')
) AS v(rate_type, value, effective_date, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c
  WHERE c.rate_type = v.rate_type AND c.scope = 'global' AND c.effective_date = v.effective_date
    AND c.created_by_name = 'System (school payroll sheet)'
);

-- ── 3. Cash advances ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_cash_advances (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            UUID NOT NULL REFERENCES public.profiles(id),
  branch_id              UUID REFERENCES public.branches(id),
  date_granted           DATE NOT NULL,
  principal              NUMERIC(12, 2) NOT NULL CHECK (principal > 0),
  installment_amount     NUMERIC(12, 2) NOT NULL CHECK (installment_amount > 0),
  -- Which payslips deduct it: both halves, or only the 1-15 / 16-end one.
  deduct_on              TEXT NOT NULL DEFAULT 'both' CHECK (deduct_on IN ('both', 'first', 'second')),
  -- First pay period (its first day) the installment is deducted from.
  start_date             DATE NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'cancelled')),
  description            TEXT,
  status_reason          TEXT,
  status_changed_by      UUID REFERENCES public.profiles(id),
  status_changed_by_name TEXT,
  status_changed_at      TIMESTAMPTZ,
  created_by             UUID REFERENCES public.profiles(id),
  created_by_name        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_cash_advances_installment_chk CHECK (installment_amount <= principal)
);

CREATE INDEX IF NOT EXISTS payroll_cash_advances_employee_idx
  ON public.payroll_cash_advances (employee_id, start_date);
CREATE INDEX IF NOT EXISTS payroll_cash_advances_branch_idx ON public.payroll_cash_advances (branch_id);
CREATE INDEX IF NOT EXISTS payroll_cash_advances_created_by_idx ON public.payroll_cash_advances (created_by);
CREATE INDEX IF NOT EXISTS payroll_cash_advances_status_changed_by_idx ON public.payroll_cash_advances (status_changed_by);

ALTER TABLE public.payroll_cash_advances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_cash_advances FROM anon, authenticated;

-- History is kept: cancel, never delete.
DROP TRIGGER IF EXISTS payroll_cash_advances_block_hard_delete ON public.payroll_cash_advances;
CREATE TRIGGER payroll_cash_advances_block_hard_delete
  BEFORE DELETE ON public.payroll_cash_advances
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- ── 4. Payslip line type ───────────────────────────────────────────────────

ALTER TABLE public.payroll_deductions DROP CONSTRAINT IF EXISTS payroll_deductions_type_check;
ALTER TABLE public.payroll_deductions ADD CONSTRAINT payroll_deductions_type_check CHECK (type IN (
  'late', 'undertime', 'half_day', 'absent', 'leave_without_pay',
  'sss', 'philhealth', 'pagibig', 'withholding_tax', 'carry_over', 'cash_advance'
));

-- ── 5. Payroll sheet header and approval block ─────────────────────────────

INSERT INTO public.system_config (section, key, value, updated_by)
VALUES
  ('payroll', 'sheet_school_name', 'SHEPHERD ANGELS CHRISTIAN SCHOOL OF ANTIPOLO, INC.', 'System (school payroll sheet)'),
  ('payroll', 'sheet_approver_name', 'MRS. ANA P. RUBANG', 'System (school payroll sheet)'),
  ('payroll', 'sheet_approver_title', 'Owner / Manager', 'System (school payroll sheet)')
ON CONFLICT (section, key) DO NOTHING;
