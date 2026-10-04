-- ═══════════════════════════════════════════════════════════════════════════
-- Semi-monthly payroll: 1st half pays half the salary, 2nd half settles the
-- whole month (src/lib/payroll/semi-monthly.js), from 2026-10-01
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. New effective-dated rates (Super Admin → Payroll Rates):
--      attendance_lock_day   day of the month attendance is locked (0 = month
--                            end). Anything dated or filed after it goes to
--                            the next month's payroll.
--      overload_premium_pct  overload pay = hourly rate × hours × (1 + this %)
--    The divisor is the existing working_days_per_year (261, 313, or 22 =
--    working days per month).
-- 2. payroll_tax_brackets: the MONTHLY withholding tax table, versioned by
--    effective date (one version = the rows saved together). Seeded with the
--    BIR monthly table (TRAIN, 2023 onward).
-- 3. payroll_contribution_amounts: a fixed monthly SSS / PhilHealth / Pag-IBIG
--    for one employee (NULL = computed from the legal table).
-- 4. payroll_monthly_incentives: incentives (₱) and overload hours per
--    employee, assigned to a payroll month by the lock day.
-- 5. payroll_thirteenth_month: the December 13th month payout.
-- 6. Payslip line types: 'incentive', 'overload' and 'carry_over'.
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
  'attendance_lock_day', 'overload_premium_pct'
));

ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_lock_day_chk;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_lock_day_chk CHECK (
  rate_type <> 'attendance_lock_day' OR (value = trunc(value) AND value BETWEEN 0 AND 31)
);

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT v.rate_type, 'global', NULL, v.value, DATE '2026-10-01', v.note, 'System (semi-monthly payroll)'
FROM (VALUES
  ('attendance_lock_day',  28, 'Attendance locked on the 28th; later items go to next month'),
  ('overload_premium_pct', 0,  'Overload pay at the plain hourly rate')
) AS v(rate_type, value, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c
  WHERE c.rate_type = v.rate_type AND c.scope = 'global'
);

-- ── 2. Monthly withholding tax table ───────────────────────────────────────
-- Tax = base_tax + rate_pct % × (taxable − bracket_over), for the highest
-- bracket_over the taxable income exceeds.

CREATE TABLE IF NOT EXISTS public.payroll_tax_brackets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       UUID NOT NULL,
  effective_date   DATE NOT NULL,
  bracket_over     NUMERIC NOT NULL CHECK (bracket_over >= 0),
  base_tax         NUMERIC NOT NULL CHECK (base_tax >= 0),
  rate_pct         NUMERIC NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  note             TEXT,
  created_by       UUID REFERENCES public.profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version_id, bracket_over)
);

CREATE INDEX IF NOT EXISTS payroll_tax_brackets_effective_idx
  ON public.payroll_tax_brackets (effective_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_tax_brackets_created_by_idx
  ON public.payroll_tax_brackets (created_by);

INSERT INTO public.payroll_tax_brackets (version_id, effective_date, bracket_over, base_tax, rate_pct, note, created_by_name)
SELECT '00000000-0000-4000-8000-000000002023'::UUID, DATE '2023-01-01', v.over, v.base, v.pct,
       'BIR monthly withholding table (RR 11-2018, 2023 onward)', 'System default'
FROM (VALUES
  (0,      0,         0),
  (20833,  0,         15),
  (33333,  1875,      20),
  (66667,  8541.80,   25),
  (166667, 33541.80,  30),
  (666667, 183541.80, 35)
) AS v(over, base, pct)
WHERE NOT EXISTS (SELECT 1 FROM public.payroll_tax_brackets);

-- ── 3. Contribution amounts per employee ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_contribution_amounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  effective_date   DATE NOT NULL,
  sss              NUMERIC CHECK (sss IS NULL OR sss >= 0),
  philhealth       NUMERIC CHECK (philhealth IS NULL OR philhealth >= 0),
  pagibig          NUMERIC CHECK (pagibig IS NULL OR pagibig >= 0),
  note             TEXT,
  created_by       UUID REFERENCES public.profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_contribution_amounts_employee_idx
  ON public.payroll_contribution_amounts (employee_id, effective_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_contribution_amounts_created_by_idx
  ON public.payroll_contribution_amounts (created_by);

-- ── 4. Incentives and overload hours ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_monthly_incentives (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  branch_id        UUID REFERENCES public.branches(id),
  item_date        DATE NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('incentive', 'overload')),
  description      TEXT NOT NULL,
  amount           NUMERIC,
  hours            NUMERIC,
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  archived_by      UUID REFERENCES public.profiles(id),
  archived_by_name TEXT,
  archived_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES public.profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_monthly_incentives_value_chk CHECK (
    (kind = 'incentive' AND amount > 0 AND hours IS NULL)
    OR (kind = 'overload' AND hours > 0 AND amount IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_employee_idx
  ON public.payroll_monthly_incentives (employee_id, item_date);
CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_branch_idx ON public.payroll_monthly_incentives (branch_id);
CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_created_by_idx ON public.payroll_monthly_incentives (created_by);
CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_archived_by_idx ON public.payroll_monthly_incentives (archived_by);

-- ── 5. 13th month pay ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_thirteenth_month (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       UUID NOT NULL REFERENCES public.profiles(id),
  employee_name     TEXT,
  year              INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  basic_earned      NUMERIC NOT NULL CHECK (basic_earned >= 0),
  amount            NUMERIC NOT NULL CHECK (amount >= 0),
  breakdown         JSONB,
  processed_by      UUID REFERENCES public.profiles(id),
  processed_by_name TEXT,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, year)
);

CREATE INDEX IF NOT EXISTS payroll_thirteenth_month_processed_by_idx ON public.payroll_thirteenth_month (processed_by);

-- ── 6. Payslip line types ──────────────────────────────────────────────────

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type IN (
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload'
));

-- Incentive / overload lines come from payroll_monthly_incentives, not a log.
ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_traceable_chk;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_traceable_chk CHECK (
  is_override
  OR type IN ('incentive', 'overload')
  OR source_log_id IS NOT NULL
  OR COALESCE(array_length(source_log_ids, 1), 0) > 0
);

ALTER TABLE public.payroll_deductions DROP CONSTRAINT IF EXISTS payroll_deductions_type_check;
ALTER TABLE public.payroll_deductions ADD CONSTRAINT payroll_deductions_type_check CHECK (type IN (
  'late', 'undertime', 'half_day', 'absent', 'leave_without_pay',
  'sss', 'philhealth', 'pagibig', 'withholding_tax', 'carry_over'
));

-- ── Access: server (service role) only ─────────────────────────────────────

ALTER TABLE public.payroll_tax_brackets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_contribution_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_monthly_incentives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_thirteenth_month ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_tax_brackets FROM anon, authenticated;
REVOKE ALL ON public.payroll_contribution_amounts FROM anon, authenticated;
REVOKE ALL ON public.payroll_monthly_incentives FROM anon, authenticated;
REVOKE ALL ON public.payroll_thirteenth_month FROM anon, authenticated;

-- History is kept: archive, never delete.
DROP TRIGGER IF EXISTS payroll_monthly_incentives_block_hard_delete ON public.payroll_monthly_incentives;
CREATE TRIGGER payroll_monthly_incentives_block_hard_delete
  BEFORE DELETE ON public.payroll_monthly_incentives
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS payroll_thirteenth_month_block_hard_delete ON public.payroll_thirteenth_month;
CREATE TRIGGER payroll_thirteenth_month_block_hard_delete
  BEFORE DELETE ON public.payroll_thirteenth_month
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();
