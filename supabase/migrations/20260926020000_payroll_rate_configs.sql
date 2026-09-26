-- ═══════════════════════════════════════════════════════════════════════════
-- Effective-dated payroll rates, traceable deduction / incentive lines,
-- and the audit snapshot kept with every processed payslip
-- ═══════════════════════════════════════════════════════════════════════════
--
-- payroll_rate_configs is append-only. A rate is never edited: a new version
-- is added with the date it takes effect, and payroll reads the version in
-- force on the pay period's first day:
--
--   SELECT value FROM payroll_rate_configs
--   WHERE rate_type = X AND effective_date <= period_start
--   ORDER BY effective_date DESC, created_at DESC LIMIT 1
--
-- (per scope, most specific first: employee, position, branch, global --
-- see src/lib/payroll/rates.js). Past payslips are therefore never affected.
--
-- Rate types:
--   hourly                    ₱ per hour: undertime, and the optional per-minute late charge
--   daily                     ₱ per day: absence, half-day and Leave Without Pay
--   half_day_pct              % of the daily rate deducted for a Half Day
--   absent_pct                % of the daily rate deducted for an Absent day
--   late_days_per_absent      every N late days in a period = 1 absence
--                             (0 turns the rule off)
--   late_minute_charge_pct    % of the hourly rate charged per late minute,
--                             on top of the rule above (0 = off)
--   early_bird_bonus          ₱ per Early Bird day
--   perfect_attendance_bonus  ₱ per pay period with no Late / Undertime /
--                             Absent / Half Day
--   sss_pct, philhealth_pct,
--   pagibig_pct               % of the period's basic salary
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.payroll_rate_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_type        TEXT NOT NULL CHECK (rate_type IN (
                     'hourly', 'daily', 'half_day_pct', 'absent_pct',
                     'late_days_per_absent', 'late_minute_charge_pct',
                     'early_bird_bonus', 'perfect_attendance_bonus',
                     'sss_pct', 'philhealth_pct', 'pagibig_pct')),
  scope            TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'branch', 'position', 'employee')),
  -- branch id / position name / employee id; NULL for global.
  scope_ref        TEXT,
  value            NUMERIC NOT NULL CHECK (value >= 0),
  effective_date   DATE NOT NULL,
  note             TEXT,
  created_by       UUID,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_rate_configs_scope_ref_chk CHECK ((scope = 'global') = (scope_ref IS NULL)),
  CONSTRAINT payroll_rate_configs_pct_chk CHECK (rate_type NOT LIKE '%\_pct' OR value <= 100),
  CONSTRAINT payroll_rate_configs_count_chk CHECK (
    rate_type <> 'late_days_per_absent' OR (value = trunc(value) AND value <= 31)
  )
);

CREATE INDEX IF NOT EXISTS payroll_rate_configs_lookup_idx
  ON public.payroll_rate_configs (rate_type, scope, scope_ref, effective_date DESC, created_at DESC);

ALTER TABLE public.payroll_rate_configs ENABLE ROW LEVEL SECURITY;

-- Append-only: no UPDATE, no DELETE, for anyone.
CREATE OR REPLACE FUNCTION public.payroll_rate_configs_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'payroll_rate_configs is append-only. Add a new version with an effective date instead of changing or removing one.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS payroll_rate_configs_no_update ON public.payroll_rate_configs;
CREATE TRIGGER payroll_rate_configs_no_update
  BEFORE UPDATE OR DELETE ON public.payroll_rate_configs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_configs_append_only();

-- Starting values, in force from 1 January 2026. They reproduce what payroll
-- charged before this release (₱550 a day for an absence or a Leave Without
-- Pay day, 3 late days = 1 absence, 2% of basic for each contribution); hourly
-- is 550 / 8. The per-minute late charge and the incentives start at zero
-- until the Super Admin sets them.
INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT v.rate_type, 'global', NULL, v.value, DATE '2026-01-01', 'Initial value', 'System default'
FROM (VALUES
  ('hourly', 68.75),
  ('daily', 550),
  ('half_day_pct', 50),
  ('absent_pct', 100),
  ('late_days_per_absent', 3),
  ('late_minute_charge_pct', 0),
  ('early_bird_bonus', 0),
  ('perfect_attendance_bonus', 0),
  ('sss_pct', 2),
  ('philhealth_pct', 2),
  ('pagibig_pct', 2)
) AS v(rate_type, value)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c WHERE c.rate_type = v.rate_type AND c.scope = 'global'
);

-- ─── Deduction and incentive lines ──────────────────────────────────────────
-- One row per line on a processed payslip. Attendance lines (late, undertime,
-- half_day, absent, early_bird) carry the attendance_logs row they came from;
-- perfect_attendance carries every log of the period in source_log_ids. A
-- manual change is stored as its own 'adjustment' line with is_override and
-- the reason, never by altering the computed lines.
CREATE TABLE IF NOT EXISTS public.payroll_deductions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_record_id  UUID REFERENCES public.payroll_records(id),
  payroll_entry_id   UUID,
  employee_id        UUID NOT NULL,
  pay_period         TEXT NOT NULL,
  period_start       DATE,
  period_end         DATE,
  type               TEXT NOT NULL CHECK (type IN (
                       'late', 'undertime', 'half_day', 'absent', 'leave_without_pay',
                       'sss', 'philhealth', 'pagibig', 'withholding_tax')),
  quantity           NUMERIC,
  unit               TEXT,
  rate               NUMERIC,
  rate_config_id     UUID REFERENCES public.payroll_rate_configs(id),
  amount             NUMERIC NOT NULL,
  source_log_id      UUID REFERENCES public.attendance_logs(id),
  source_log_ids     UUID[],
  is_override        BOOLEAN NOT NULL DEFAULT FALSE,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_deductions_traceable_chk CHECK (
    is_override
    OR type NOT IN ('late', 'undertime', 'half_day', 'absent')
    OR source_log_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS payroll_deductions_record_idx ON public.payroll_deductions (payroll_record_id);
CREATE INDEX IF NOT EXISTS payroll_deductions_employee_period_idx ON public.payroll_deductions (employee_id, pay_period);
CREATE INDEX IF NOT EXISTS payroll_deductions_log_idx ON public.payroll_deductions (source_log_id);

CREATE TABLE IF NOT EXISTS public.payroll_incentives (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_record_id  UUID REFERENCES public.payroll_records(id),
  payroll_entry_id   UUID,
  employee_id        UUID NOT NULL,
  pay_period         TEXT NOT NULL,
  period_start       DATE,
  period_end         DATE,
  type               TEXT NOT NULL CHECK (type IN ('early_bird', 'perfect_attendance')),
  quantity           NUMERIC,
  unit               TEXT,
  rate               NUMERIC,
  rate_config_id     UUID REFERENCES public.payroll_rate_configs(id),
  amount             NUMERIC NOT NULL,
  source_log_id      UUID REFERENCES public.attendance_logs(id),
  source_log_ids     UUID[],
  is_override        BOOLEAN NOT NULL DEFAULT FALSE,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_incentives_traceable_chk CHECK (
    is_override
    OR source_log_id IS NOT NULL
    OR COALESCE(array_length(source_log_ids, 1), 0) > 0
  )
);

CREATE INDEX IF NOT EXISTS payroll_incentives_record_idx ON public.payroll_incentives (payroll_record_id);
CREATE INDEX IF NOT EXISTS payroll_incentives_employee_period_idx ON public.payroll_incentives (employee_id, pay_period);

ALTER TABLE public.payroll_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_incentives ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS payroll_deductions_block_hard_delete ON public.payroll_deductions;
CREATE TRIGGER payroll_deductions_block_hard_delete
  BEFORE DELETE ON public.payroll_deductions
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS payroll_incentives_block_hard_delete ON public.payroll_incentives;
CREATE TRIGGER payroll_incentives_block_hard_delete
  BEFORE DELETE ON public.payroll_incentives
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

-- ─── Payslip audit snapshot ─────────────────────────────────────────────────
-- payroll_records is this system's payslip table. Each processed payslip now
-- also keeps: the rate versions it used, the attendance logs behind each
-- line, any manual deviations (who / why), and who processed it and when
-- (processed_at already existed).
ALTER TABLE public.payroll_records
  ADD COLUMN IF NOT EXISTS base_pay              NUMERIC,
  ADD COLUMN IF NOT EXISTS total_incentives      NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_start          DATE,
  ADD COLUMN IF NOT EXISTS period_end            DATE,
  ADD COLUMN IF NOT EXISTS rate_version_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS attendance_snapshot   JSONB,
  ADD COLUMN IF NOT EXISTS deviations            JSONB,
  ADD COLUMN IF NOT EXISTS processed_by          UUID,
  ADD COLUMN IF NOT EXISTS processed_by_name     TEXT;
