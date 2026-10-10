-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO LIVE 2026-10-09 via the Management API (migration history name:
-- payslip_schedule_loans_awol_subsidy). Tested first on a PGlite copy, 90/90.
-- Part B (cash advances read-only) is a separate, later step:
-- after scripts/migrate-cash-advances-to-loans.mjs.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds: the payslip schedule (replaces attendance_lock_day; previous working
-- day rule), the shared settings/license change log, the licensed teacher
-- subsidy (settings, yearly balances, missed-month adjustments), licensed
-- teacher fields with HR-only changes and expiry alerts, one loan system
-- (incl. subsidy advances and the refused-consent decision), AWOL cases and
-- payroll hold, the 261-day divisor, and the editable exempt ceiling.
--
-- Safe to run more than once.

-- ═══════════════════════════════════════════════════════════════════════════
-- Payslip schedule, loans, AWOL cases, licensed teacher subsidy
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Shared helpers ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: save a new version instead.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- One shared change log: versioned payroll settings and every license change.
CREATE TABLE IF NOT EXISTS public.payroll_setting_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_type    TEXT NOT NULL CHECK (setting_type IN ('payslip_schedule', 'teacher_subsidy', 'teacher_license')),
  setting_id      UUID NOT NULL,       -- the settings row, or the employee_license_changes row
  employee_id     UUID,                -- set for 'teacher_license'
  effective_from  DATE NOT NULL,
  old_value       JSONB NOT NULL,
  new_value       JSONB NOT NULL,
  reason          TEXT,
  changed_by      UUID,
  changed_by_name TEXT,
  changed_by_role TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_setting_changes_employee_chk
    CHECK ((setting_type = 'teacher_license') = (employee_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS payroll_setting_changes_type_idx
  ON public.payroll_setting_changes (setting_type, changed_at DESC);
CREATE INDEX IF NOT EXISTS payroll_setting_changes_employee_idx
  ON public.payroll_setting_changes (employee_id, changed_at DESC) WHERE employee_id IS NOT NULL;

-- ── 1. Payslip schedule settings ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_schedule_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from       DATE NOT NULL CHECK (EXTRACT(DAY FROM effective_from) IN (1, 16)),
  first_half_day       SMALLINT CHECK (first_half_day BETWEEN 1 AND 15),     -- NULL = the 15th
  second_half_day      SMALLINT CHECK (second_half_day BETWEEN 16 AND 31),   -- NULL = month end
  window_days          SMALLINT NOT NULL DEFAULT 5 CHECK (window_days BETWEEN 1 AND 15),
  non_working_day_rule TEXT NOT NULL DEFAULT 'previous_working_day'
                       CHECK (non_working_day_rule IN ('same_day', 'previous_working_day', 'next_working_day')),
  note                 TEXT NOT NULL CHECK (length(trim(note)) > 0),  -- reason for the change
  created_by           UUID REFERENCES public.profiles(id),
  created_by_name      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_schedule_settings_effective_idx
  ON public.payroll_schedule_settings (effective_from DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_schedule_settings_created_by_idx
  ON public.payroll_schedule_settings (created_by);

-- The generation date of one period under the given settings.
CREATE OR REPLACE FUNCTION public.payroll_generation_date_for(
  p_period_start    DATE,
  p_first_half_day  SMALLINT,
  p_second_half_day SMALLINT,
  p_rule            TEXT
)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_month_start DATE := date_trunc('month', p_period_start)::DATE;
  v_month_end   DATE := (date_trunc('month', p_period_start) + INTERVAL '1 month - 1 day')::DATE;
  v_day         DATE;
  v_steps       INTEGER := 0;
BEGIN
  IF EXTRACT(DAY FROM p_period_start) = 1 THEN
    v_day := v_month_start + (COALESCE(p_first_half_day, 15) - 1);
  ELSE
    v_day := LEAST(v_month_start + (COALESCE(p_second_half_day, 31) - 1), v_month_end);
  END IF;

  WHILE COALESCE(p_rule, 'previous_working_day') <> 'same_day'
        AND public.attendance_is_rest_day(v_day)
        AND v_steps < 14 LOOP
    v_day := v_day + CASE WHEN COALESCE(p_rule, 'previous_working_day') = 'previous_working_day' THEN -1 ELSE 1 END;
    v_steps := v_steps + 1;
  END LOOP;

  RETURN v_day;
END;
$$;

-- The schedule in force for a period (no settings row = the defaults).
-- attendance_cutoff: last attendance day the 2nd half deducts; NULL for the
-- 1st half. Replaces the attendance_lock_day rate.
CREATE OR REPLACE FUNCTION public.payroll_schedule_for(p_period_start DATE)
RETURNS TABLE (
  generation_date      DATE,
  closes_on            DATE,
  window_days          SMALLINT,
  non_working_day_rule TEXT,
  attendance_cutoff    DATE
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH setting AS (
    SELECT x.first_half_day,
           x.second_half_day,
           COALESCE(x.window_days, 5::SMALLINT)                     AS days,
           COALESCE(x.non_working_day_rule, 'previous_working_day') AS rule
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM public.payroll_schedule_settings s
      WHERE s.effective_from <= p_period_start
      ORDER BY s.effective_from DESC, s.created_at DESC
      LIMIT 1
    ) x ON TRUE
  ), gen AS (
    SELECT public.payroll_generation_date_for(p_period_start, s.first_half_day, s.second_half_day, s.rule) AS d,
           s.days, s.rule
    FROM setting s
  )
  SELECT g.d,
         g.d + (g.days - 1),
         g.days,
         g.rule,
         CASE WHEN EXTRACT(DAY FROM p_period_start) = 16
              THEN LEAST(g.d - 1, (date_trunc('month', p_period_start) + INTERVAL '1 month - 1 day')::DATE)
         END
  FROM gen g;
$$;

-- Upcoming periods only: neither the old nor the new generation date may
-- have arrived (Manila time).
CREATE OR REPLACE FUNCTION public.payroll_schedule_settings_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_old   DATE;
  v_new   DATE;
BEGIN
  SELECT generation_date INTO v_old FROM public.payroll_schedule_for(NEW.effective_from);
  v_new := public.payroll_generation_date_for(NEW.effective_from, NEW.first_half_day, NEW.second_half_day, NEW.non_working_day_rule);
  IF v_old <= v_today OR v_new <= v_today THEN
    RAISE EXCEPTION 'Schedule changes apply to upcoming pay periods only: the period starting % has already reached its generation date.', NEW.effective_from
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. Licensed teacher subsidy settings ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_subsidy_settings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- First day of the first subsidy year these settings govern.
  effective_year_start DATE NOT NULL CHECK (EXTRACT(DAY FROM effective_year_start) = 1),
  annual_amount        NUMERIC(12, 2) NOT NULL DEFAULT 24000 CHECK (annual_amount > 0),
  year_basis           TEXT NOT NULL DEFAULT 'calendar' CHECK (year_basis IN ('calendar', 'school_year')),
  year_start_month     SMALLINT NOT NULL DEFAULT 1 CHECK (year_start_month BETWEEN 1 AND 12),
  payout_month         SMALLINT CHECK (payout_month BETWEEN 1 AND 12),   -- NULL = the year's last month
  proration            TEXT NOT NULL DEFAULT 'monthly' CHECK (proration IN ('monthly', 'none')),
  advance_limit        TEXT NOT NULL DEFAULT 'full_year' CHECK (advance_limit IN ('full_year', 'earned_to_date')),
  on_resignation       TEXT NOT NULL DEFAULT 'prorate' CHECK (on_resignation IN ('prorate', 'forfeit')),
  on_dismissal         TEXT NOT NULL DEFAULT 'forfeit' CHECK (on_dismissal IN ('prorate', 'forfeit')),
  tax_treatment        TEXT NOT NULL DEFAULT 'other_benefit' CHECK (tax_treatment IN ('other_benefit', 'taxable', 'exempt')),
  note                 TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_by           UUID REFERENCES public.profiles(id),
  created_by_name      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_subsidy_settings_calendar_chk
    CHECK (year_basis <> 'calendar' OR year_start_month = 1),
  CONSTRAINT payroll_subsidy_settings_anchor_chk
    CHECK (EXTRACT(MONTH FROM effective_year_start) = year_start_month)
);

CREATE INDEX IF NOT EXISTS payroll_subsidy_settings_effective_idx
  ON public.payroll_subsidy_settings (effective_year_start DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_subsidy_settings_created_by_idx
  ON public.payroll_subsidy_settings (created_by);

-- The subsidy year containing p_day and its settings (none saved = the
-- defaults: calendar year, ₱24,000). A year is cut short when a later
-- version starts earlier (calendar → school-year bridge).
CREATE OR REPLACE FUNCTION public.payroll_subsidy_year_for(p_day DATE)
RETURNS TABLE (
  setting_id          UUID,
  year_start          DATE,
  year_end            DATE,
  payout_period_start DATE,
  annual_amount       NUMERIC,
  proration           TEXT,
  advance_limit       TEXT,
  on_resignation      TEXT,
  on_dismissal        TEXT,
  tax_treatment       TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s        public.payroll_subsidy_settings%ROWTYPE;
  v_start  DATE;
  v_end    DATE;
  v_next   DATE;
  v_payout DATE;
BEGIN
  SELECT * INTO s
  FROM public.payroll_subsidy_settings x
  WHERE x.effective_year_start <= p_day
  ORDER BY x.effective_year_start DESC, x.created_at DESC
  LIMIT 1;

  IF s.id IS NULL THEN
    s.annual_amount := 24000;  s.year_start_month := 1;   s.proration := 'monthly';
    s.advance_limit := 'full_year'; s.on_resignation := 'prorate'; s.on_dismissal := 'forfeit';
    s.tax_treatment := 'other_benefit';
  END IF;

  v_start := make_date(EXTRACT(YEAR FROM p_day)::INTEGER, s.year_start_month, 1);
  IF v_start > p_day THEN
    v_start := (v_start - INTERVAL '1 year')::DATE;
  END IF;
  v_end := (v_start + INTERVAL '1 year')::DATE - 1;

  SELECT MIN(x.effective_year_start) INTO v_next
  FROM public.payroll_subsidy_settings x
  WHERE x.effective_year_start > v_start;
  IF v_next IS NOT NULL AND v_next - 1 < v_end THEN
    v_end := v_next - 1;
  END IF;

  -- Paid on the 2nd-half payslip (the 16th) of the payout month.
  SELECT (m + INTERVAL '15 days')::DATE INTO v_payout
  FROM generate_series(date_trunc('month', v_start), date_trunc('month', v_end), INTERVAL '1 month') AS m
  WHERE EXTRACT(MONTH FROM m) = COALESCE(s.payout_month, EXTRACT(MONTH FROM v_end))
  ORDER BY m DESC
  LIMIT 1;
  v_payout := COALESCE(v_payout, (date_trunc('month', v_end) + INTERVAL '15 days')::DATE);

  RETURN QUERY SELECT s.id, v_start, v_end, v_payout, s.annual_amount, s.proration,
                      s.advance_limit, s.on_resignation, s.on_dismissal, s.tax_treatment;
END;
$$;

-- Next subsidy year only: the new version must start after the current year ends.
CREATE OR REPLACE FUNCTION public.payroll_subsidy_settings_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_current_end DATE;
BEGIN
  SELECT year_end INTO v_current_end
  FROM public.payroll_subsidy_year_for((NOW() AT TIME ZONE 'Asia/Manila')::DATE);
  IF NEW.effective_year_start <= v_current_end THEN
    RAISE EXCEPTION 'Subsidy changes apply from the next subsidy year: choose a start after %.', v_current_end
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3. Settings history (both settings tables) ─────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_settings_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_meta TEXT[] := ARRAY['id', 'note', 'created_by', 'created_by_name', 'created_at'];
  v_type TEXT;
  v_from DATE;
  v_prev JSONB;
BEGIN
  IF TG_TABLE_NAME = 'payroll_schedule_settings' THEN
    v_type := 'payslip_schedule';
    v_from := NEW.effective_from;
    SELECT to_jsonb(p) - v_meta INTO v_prev
    FROM public.payroll_schedule_settings p
    WHERE p.id <> NEW.id AND p.effective_from <= NEW.effective_from
    ORDER BY p.effective_from DESC, p.created_at DESC
    LIMIT 1;
    v_prev := COALESCE(v_prev, jsonb_build_object(
      'first_half_day', NULL, 'second_half_day', NULL, 'window_days', 5,
      'non_working_day_rule', 'previous_working_day', 'source', 'system default'));
  ELSE
    v_type := 'teacher_subsidy';
    v_from := NEW.effective_year_start;
    SELECT to_jsonb(p) - v_meta INTO v_prev
    FROM public.payroll_subsidy_settings p
    WHERE p.id <> NEW.id AND p.effective_year_start <= NEW.effective_year_start
    ORDER BY p.effective_year_start DESC, p.created_at DESC
    LIMIT 1;
    v_prev := COALESCE(v_prev, jsonb_build_object(
      'annual_amount', 24000, 'year_basis', 'calendar', 'year_start_month', 1, 'payout_month', NULL,
      'proration', 'monthly', 'advance_limit', 'full_year', 'on_resignation', 'prorate',
      'on_dismissal', 'forfeit', 'tax_treatment', 'other_benefit', 'source', 'system default'));
  END IF;

  INSERT INTO public.payroll_setting_changes
    (setting_type, setting_id, effective_from, old_value, new_value, reason, changed_by, changed_by_name)
  VALUES
    (v_type, NEW.id, v_from, v_prev, to_jsonb(NEW) - v_meta, NEW.note, NEW.created_by, NEW.created_by_name);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payroll_schedule_settings_guard ON public.payroll_schedule_settings;
CREATE TRIGGER payroll_schedule_settings_guard
  BEFORE INSERT ON public.payroll_schedule_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_schedule_settings_guard();

DROP TRIGGER IF EXISTS payroll_subsidy_settings_guard ON public.payroll_subsidy_settings;
CREATE TRIGGER payroll_subsidy_settings_guard
  BEFORE INSERT ON public.payroll_subsidy_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_subsidy_settings_guard();

DROP TRIGGER IF EXISTS payroll_schedule_settings_log ON public.payroll_schedule_settings;
CREATE TRIGGER payroll_schedule_settings_log
  AFTER INSERT ON public.payroll_schedule_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_settings_log();

DROP TRIGGER IF EXISTS payroll_subsidy_settings_log ON public.payroll_subsidy_settings;
CREATE TRIGGER payroll_subsidy_settings_log
  AFTER INSERT ON public.payroll_subsidy_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_settings_log();

DROP TRIGGER IF EXISTS payroll_schedule_settings_append_only ON public.payroll_schedule_settings;
CREATE TRIGGER payroll_schedule_settings_append_only
  BEFORE UPDATE OR DELETE ON public.payroll_schedule_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only();

DROP TRIGGER IF EXISTS payroll_subsidy_settings_append_only ON public.payroll_subsidy_settings;
CREATE TRIGGER payroll_subsidy_settings_append_only
  BEFORE UPDATE OR DELETE ON public.payroll_subsidy_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only();

DROP TRIGGER IF EXISTS payroll_setting_changes_append_only ON public.payroll_setting_changes;
CREATE TRIGGER payroll_setting_changes_append_only
  BEFORE UPDATE OR DELETE ON public.payroll_setting_changes
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only();

-- ── 4. Divisor: the school's real working days (decision 3) ────────────────
-- A newer version on the same effective date wins (rates.js: effective_date
-- DESC, created_at DESC), replacing the school sheet's 24.

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT 'working_days_per_year', 'global', NULL, 261, DATE '2026-10-01',
       'Real working days: Monday to Friday (52 × 5 + 1)', 'System (payslip schedule)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c
  WHERE c.rate_type = 'working_days_per_year' AND c.created_by_name = 'System (payslip schedule)'
);

-- Exempt ceiling shared by the 13th month and the "other benefit" subsidy
-- (decision 10). Editable in Super Admin → Payroll Rates, effective-dated.
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
  'benefits_exempt_ceiling'
));

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT 'benefits_exempt_ceiling', 'global', NULL, 90000, DATE '2018-01-01',
       '13th month and other benefits exempt up to this amount a year (TRAIN law)', 'System (teacher subsidy)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c WHERE c.rate_type = 'benefits_exempt_ceiling'
);

-- ── 5. Licensed teachers ───────────────────────────────────────────────────

-- Teaching staff only. Off by default: an unlicensed teacher is a normal
-- record with no PRC fields. The PRC number is encrypted with the existing
-- Vault key, like SSS / TIN (private.encrypt_pii); screens show the last 4.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_licensed_teacher      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS prc_license_no_enc       BYTEA,
  ADD COLUMN IF NOT EXISTS prc_license_no_last4     TEXT,
  ADD COLUMN IF NOT EXISTS license_expires_on       DATE,
  ADD COLUMN IF NOT EXISTS prc_id_document_id       UUID,
  ADD COLUMN IF NOT EXISTS license_verified_by      UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS license_verified_by_name TEXT,
  ADD COLUMN IF NOT EXISTS license_verified_at      TIMESTAMPTZ;

-- Optional PRC ID scan, the same shape leave proofs accept
-- (src/lib/leave-requests/proof.js: PDF / PNG / JPEG data URL, 2 MB file).
-- Its own table, so reading a profile never carries the file.
CREATE TABLE IF NOT EXISTS public.employee_license_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  file_name        TEXT,
  data_url         TEXT NOT NULL CHECK (
                     data_url ~ '^data:(application/pdf|image/png|image/jpeg);base64,[A-Za-z0-9+/]+={0,2}$'
                     AND length(data_url) <= 2800100),
  uploaded_by      UUID REFERENCES public.profiles(id),
  uploaded_by_name TEXT,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employee_license_documents_employee_idx
  ON public.employee_license_documents (employee_id, uploaded_at DESC);

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_prc_id_document_fk;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_prc_id_document_fk
  FOREIGN KEY (prc_id_document_id) REFERENCES public.employee_license_documents(id);

-- On: Teaching only (the app treats an empty type as Teaching), number and
-- expiry required. Off: no PRC data kept on the profile.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_licensed_teacher_chk;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_licensed_teacher_chk CHECK (
  CASE WHEN is_licensed_teacher
    THEN COALESCE(employee_type, 'Teaching') = 'Teaching'
         AND prc_license_no_enc IS NOT NULL AND license_expires_on IS NOT NULL
    ELSE prc_license_no_enc IS NULL AND license_expires_on IS NULL
         AND prc_id_document_id IS NULL AND license_verified_at IS NULL
  END
);

CREATE INDEX IF NOT EXISTS profiles_license_expiry_idx
  ON public.profiles (license_expires_on) WHERE is_licensed_teacher;

-- Every license change, the only way the fields above change. The API
-- inserts the action and inputs; the trigger fills in the state after it.
CREATE TABLE IF NOT EXISTS public.employee_license_changes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          UUID NOT NULL REFERENCES public.profiles(id),
  action               TEXT NOT NULL CHECK (action IN ('turn_on', 'update_details', 'verify', 'turn_off', 'expire')),
  prc_license_no       TEXT,           -- input only: encrypted by the trigger, then cleared
  is_licensed          BOOLEAN NOT NULL DEFAULT FALSE,
  prc_license_no_enc   BYTEA,
  prc_license_no_last4 TEXT,
  license_expires_on   DATE,
  prc_id_document_id   UUID REFERENCES public.employee_license_documents(id),
  verified             BOOLEAN NOT NULL DEFAULT FALSE,
  eligible             BOOLEAN NOT NULL DEFAULT FALSE,   -- on + verified + not expired
  effective_on         DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::DATE),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  changed_by           UUID,
  changed_by_name      TEXT,
  changed_by_role      TEXT NOT NULL CHECK (changed_by_role IN ('hr', 'system')),   -- decision 16
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_license_changes_no_plaintext_chk CHECK (prc_license_no IS NULL)
);

CREATE INDEX IF NOT EXISTS employee_license_changes_employee_idx
  ON public.employee_license_changes (employee_id, effective_on DESC, changed_at DESC);

CREATE OR REPLACE FUNCTION public.employee_license_changes_apply()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  p           public.profiles%ROWTYPE;
  v_today     DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_no        TEXT := NULLIF(trim(COALESCE(NEW.prc_license_no, '')), '');
  v_in_expiry DATE := NEW.license_expires_on;
  v_in_doc    UUID := NEW.prc_id_document_id;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id = NEW.employee_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee % not found.', NEW.employee_id;
  END IF;

  -- No back- or future-dating: eligibility counts from the day it changes.
  IF NEW.action = 'expire' THEN
    IF NEW.changed_by_role <> 'system' OR p.license_expires_on IS NULL
       OR NEW.effective_on <> p.license_expires_on + 1 THEN
      RAISE EXCEPTION 'Only the daily job records an expiry, dated the day after the expiry date.';
    END IF;
  ELSIF NEW.changed_by_role <> 'hr' OR NEW.effective_on <> v_today THEN
    RAISE EXCEPTION 'License changes are made by HR and take effect today.';
  END IF;

  -- Start from the current state.
  NEW.is_licensed          := p.is_licensed_teacher;
  NEW.prc_license_no_enc   := p.prc_license_no_enc;
  NEW.prc_license_no_last4 := p.prc_license_no_last4;
  NEW.license_expires_on   := p.license_expires_on;
  NEW.prc_id_document_id   := p.prc_id_document_id;
  NEW.verified             := p.license_verified_at IS NOT NULL;

  CASE NEW.action
    WHEN 'turn_on', 'update_details' THEN
      IF COALESCE(p.employee_type, 'Teaching') <> 'Teaching' THEN
        RAISE EXCEPTION 'Only Teaching staff can be licensed teachers.';
      END IF;
      IF (NEW.action = 'turn_on') = p.is_licensed_teacher THEN
        RAISE EXCEPTION 'The licensed-teacher switch is already %.', CASE WHEN p.is_licensed_teacher THEN 'on' ELSE 'off' END;
      END IF;
      NEW.is_licensed := TRUE;
      IF v_no IS NOT NULL THEN
        NEW.prc_license_no_enc   := private.encrypt_pii(v_no);
        NEW.prc_license_no_last4 := right(v_no, 4);
      END IF;
      NEW.license_expires_on := COALESCE(v_in_expiry, NEW.license_expires_on);
      NEW.prc_id_document_id := COALESCE(v_in_doc, NEW.prc_id_document_id);
      IF NEW.prc_license_no_enc IS NULL OR NEW.license_expires_on IS NULL THEN
        RAISE EXCEPTION 'The PRC license number and expiry date are required.';
      END IF;
      IF NEW.license_expires_on <= v_today THEN
        RAISE EXCEPTION 'The license expiry date must be after today.';
      END IF;
      NEW.verified := FALSE;   -- any change needs HR to verify again
    WHEN 'verify' THEN
      IF NEW.changed_by_role <> 'hr' THEN
        RAISE EXCEPTION 'Only HR verifies a license.';
      END IF;
      IF NOT p.is_licensed_teacher OR p.license_expires_on < v_today THEN
        RAISE EXCEPTION 'There is no unexpired license to verify.';
      END IF;
      NEW.verified := TRUE;
    WHEN 'turn_off' THEN
      NEW.is_licensed := FALSE;   -- the details stay on this history row
      NEW.verified := FALSE;
    WHEN 'expire' THEN
      NULL;                       -- state unchanged; eligibility ends below
  END CASE;

  NEW.prc_license_no := NULL;
  NEW.eligible := NEW.action <> 'expire' AND NEW.is_licensed AND NEW.verified
                  AND NEW.license_expires_on >= NEW.effective_on;

  PERFORM set_config('app.license_apply', 'on', TRUE);
  UPDATE public.profiles
  SET is_licensed_teacher      = NEW.is_licensed,
      prc_license_no_enc       = CASE WHEN NEW.is_licensed THEN NEW.prc_license_no_enc END,
      prc_license_no_last4     = CASE WHEN NEW.is_licensed THEN NEW.prc_license_no_last4 END,
      license_expires_on       = CASE WHEN NEW.is_licensed THEN NEW.license_expires_on END,
      prc_id_document_id       = CASE WHEN NEW.is_licensed THEN NEW.prc_id_document_id END,
      license_verified_by      = CASE WHEN NOT NEW.verified THEN NULL
                                      WHEN NEW.action = 'verify' THEN NEW.changed_by
                                      ELSE license_verified_by END,
      license_verified_by_name = CASE WHEN NOT NEW.verified THEN NULL
                                      WHEN NEW.action = 'verify' THEN NEW.changed_by_name
                                      ELSE license_verified_by_name END,
      license_verified_at      = CASE WHEN NOT NEW.verified THEN NULL
                                      WHEN NEW.action = 'verify' THEN NOW()
                                      ELSE license_verified_at END
  WHERE id = NEW.employee_id;
  PERFORM set_config('app.license_apply', 'off', TRUE);

  -- Shared change log (decision 12). Only the last 4 digits of the PRC number.
  INSERT INTO public.payroll_setting_changes
    (setting_type, setting_id, employee_id, effective_from, old_value, new_value,
     reason, changed_by, changed_by_name, changed_by_role)
  VALUES (
    'teacher_license', NEW.id, NEW.employee_id, NEW.effective_on,
    jsonb_build_object('is_licensed', p.is_licensed_teacher, 'prc_last4', p.prc_license_no_last4,
                       'expires_on', p.license_expires_on, 'prc_id_document_id', p.prc_id_document_id,
                       'verified', p.license_verified_at IS NOT NULL),
    jsonb_build_object('action', NEW.action, 'is_licensed', NEW.is_licensed, 'prc_last4', NEW.prc_license_no_last4,
                       'expires_on', NEW.license_expires_on, 'prc_id_document_id', NEW.prc_id_document_id,
                       'verified', NEW.verified, 'eligible', NEW.eligible),
    NEW.reason, NEW.changed_by, NEW.changed_by_name, NEW.changed_by_role
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_license_changes_apply ON public.employee_license_changes;
CREATE TRIGGER employee_license_changes_apply
  BEFORE INSERT ON public.employee_license_changes
  FOR EACH ROW EXECUTE FUNCTION public.employee_license_changes_apply();

-- Licensed-teacher fields change only through employee_license_changes.
CREATE OR REPLACE FUNCTION public.profiles_license_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.license_apply', TRUE) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' AND NEW.is_licensed_teacher THEN
      RAISE EXCEPTION 'Create the employee first, then HR records the license.';
    ELSIF TG_OP = 'UPDATE'
      AND (NEW.is_licensed_teacher, NEW.prc_license_no_enc, NEW.prc_license_no_last4, NEW.license_expires_on,
           NEW.prc_id_document_id, NEW.license_verified_by, NEW.license_verified_at)
          IS DISTINCT FROM
          (OLD.is_licensed_teacher, OLD.prc_license_no_enc, OLD.prc_license_no_last4, OLD.license_expires_on,
           OLD.prc_id_document_id, OLD.license_verified_by, OLD.license_verified_at) THEN
      RAISE EXCEPTION 'Licensed-teacher fields change only through a logged license change by HR.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_license_guard ON public.profiles;
CREATE TRIGGER profiles_license_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_license_guard();

-- Eligible on a day: the latest change on or before it says on + verified,
-- and the license has not expired by that day.
CREATE OR REPLACE FUNCTION public.teacher_subsidy_eligible_on(p_employee UUID, p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT c.eligible AND c.license_expires_on >= p_day
    FROM public.employee_license_changes c
    WHERE c.employee_id = p_employee AND c.effective_on <= p_day
    ORDER BY c.effective_on DESC, c.changed_at DESC
    LIMIT 1
  ), FALSE);
$$;

-- Expiry warnings for HR (warning days = Super Admin setting, default 60).
INSERT INTO public.system_config (section, key, value, updated_by)
VALUES ('hr', 'license_expiry_warning_days', '60', 'System (teacher license)')
ON CONFLICT (section, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.employee_license_alerts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          UUID NOT NULL REFERENCES public.profiles(id),
  branch_id            UUID REFERENCES public.branches(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('expiring', 'expired')),
  license_expires_on   DATE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_by      UUID REFERENCES public.profiles(id),
  acknowledged_by_name TEXT,
  acknowledged_at      TIMESTAMPTZ,
  UNIQUE (employee_id, kind, license_expires_on)
);

CREATE INDEX IF NOT EXISTS employee_license_alerts_open_idx
  ON public.employee_license_alerts (branch_id, created_at DESC) WHERE acknowledged_at IS NULL;

-- ── 6. Subsidy balance per teacher per year ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_subsidy_balances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL REFERENCES public.profiles(id),
  subsidy_year_start  DATE NOT NULL,
  subsidy_year_end    DATE NOT NULL,
  payout_period_start DATE NOT NULL CHECK (EXTRACT(DAY FROM payout_period_start) = 16),
  -- What it was granted under (never changes after the year opens).
  setting_id          UUID REFERENCES public.payroll_subsidy_settings(id),
  annual_amount       NUMERIC(12, 2) NOT NULL CHECK (annual_amount > 0),
  proration           TEXT NOT NULL,
  advance_limit       TEXT NOT NULL,
  on_resignation      TEXT NOT NULL,
  on_dismissal        TEXT NOT NULL,
  tax_treatment       TEXT NOT NULL,
  -- Months that count (employed and eligible on the 15th), projected to year end.
  eligible_from       DATE NOT NULL,
  eligible_months     SMALLINT NOT NULL CHECK (eligible_months BETWEEN 0 AND 12),
  entitlement         NUMERIC(12, 2) NOT NULL CHECK (entitlement >= 0),
  advances_total      NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (advances_total >= 0),
  -- Last year's excess advance offset against this year (§6.7).
  carried_in          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (carried_in >= 0),
  paid_out            NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (paid_out >= 0),
  paid_out_on         DATE,           -- counts toward that tax year's exempt ceiling
  forfeited           NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (forfeited >= 0),
  -- Negative = advances above the entitlement (license lost, separation).
  remaining           NUMERIC(12, 2) GENERATED ALWAYS AS
                        (entitlement - advances_total - carried_in - paid_out - forfeited) STORED,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid_out', 'forfeited', 'settled_in_final_pay')),
  payout_entry_id     UUID,           -- the payslip (or final pay) that settled it
  status_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, subsidy_year_start)
);

CREATE INDEX IF NOT EXISTS payroll_subsidy_balances_payout_idx
  ON public.payroll_subsidy_balances (payout_period_start, status);
CREATE INDEX IF NOT EXISTS payroll_subsidy_balances_setting_idx
  ON public.payroll_subsidy_balances (setting_id);

-- Months of a subsidy year that count: employed and eligible on the 15th.
-- Past 15ths read the license history; future 15ths are projected only
-- while the teacher is eligible today and the current license is still
-- valid on that 15th. Separation is settled by the final-pay code.
CREATE OR REPLACE FUNCTION public.teacher_subsidy_months(
  p_employee   UUID,
  p_year_start DATE,
  p_year_end   DATE,
  p_today      DATE
)
RETURNS TABLE (eligible_from DATE, months SMALLINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH p AS (
    SELECT pr.date_hired, pr.license_expires_on,
           public.teacher_subsidy_eligible_on(pr.id, p_today) AS eligible_now
    FROM public.profiles pr
    WHERE pr.id = p_employee
  ), m AS (
    SELECT gs::DATE AS month_start, gs::DATE + 14 AS d15
    FROM generate_series(date_trunc('month', p_year_start), date_trunc('month', p_year_end), INTERVAL '1 month') AS gs
  )
  SELECT MIN(m.month_start), COUNT(*)::SMALLINT
  FROM m CROSS JOIN p
  WHERE m.d15 BETWEEN p_year_start AND p_year_end
    AND (p.date_hired IS NULL OR p.date_hired <= m.d15)
    AND CASE WHEN m.d15 <= p_today
             THEN public.teacher_subsidy_eligible_on(p_employee, m.d15)
             ELSE p.eligible_now AND p.license_expires_on >= m.d15
        END;
$$;

-- Opens or recomputes one teacher's row for the subsidy year containing
-- p_day. An open row keeps the amount and settings it was granted under;
-- only the months (and so the entitlement) move.
CREATE OR REPLACE FUNCTION public.payroll_subsidy_refresh(
  p_employee UUID,
  p_day      DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  y RECORD;
  e RECORD;
BEGIN
  SELECT * INTO y FROM public.payroll_subsidy_year_for(p_day);
  SELECT * INTO e FROM public.teacher_subsidy_months(p_employee, y.year_start, y.year_end, p_day);

  UPDATE public.payroll_subsidy_balances b
  SET eligible_from   = COALESCE(e.eligible_from, b.eligible_from),
      eligible_months = COALESCE(e.months, 0),
      entitlement     = CASE WHEN COALESCE(e.months, 0) = 0 THEN 0
                             WHEN b.proration = 'none' THEN b.annual_amount
                             ELSE round(b.annual_amount * e.months / 12.0, 2) END,
      updated_at      = NOW()
  WHERE b.employee_id = p_employee
    AND b.subsidy_year_start = y.year_start
    AND b.status = 'open';

  IF FOUND OR COALESCE(e.months, 0) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.payroll_subsidy_balances (
    employee_id, subsidy_year_start, subsidy_year_end, payout_period_start, setting_id,
    annual_amount, proration, advance_limit, on_resignation, on_dismissal, tax_treatment,
    eligible_from, eligible_months, entitlement)
  VALUES (
    p_employee, y.year_start, y.year_end, y.payout_period_start, y.setting_id,
    y.annual_amount, y.proration, y.advance_limit, y.on_resignation, y.on_dismissal, y.tax_treatment,
    e.eligible_from, e.months,
    CASE WHEN y.proration = 'none' THEN y.annual_amount
         ELSE round(y.annual_amount * e.months / 12.0, 2) END)
  ON CONFLICT (employee_id, subsidy_year_start) DO NOTHING;
END;
$$;

-- A license change moves the subsidy at once (newly verified → row opens;
-- switched off / expired → months stop).
CREATE OR REPLACE FUNCTION public.employee_license_changes_refresh_subsidy()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.payroll_subsidy_refresh(NEW.employee_id, (NOW() AT TIME ZONE 'Asia/Manila')::DATE);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS employee_license_changes_refresh_subsidy ON public.employee_license_changes;
CREATE TRIGGER employee_license_changes_refresh_subsidy
  AFTER INSERT ON public.employee_license_changes
  FOR EACH ROW EXECUTE FUNCTION public.employee_license_changes_refresh_subsidy();

-- Every eligible teacher's row for the year containing p_day (picks up the
-- new year on its first day).
CREATE OR REPLACE FUNCTION public.payroll_subsidy_open_year(
  p_day DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT p.id FROM public.profiles p
    WHERE p.is_licensed_teacher AND p.license_verified_at IS NOT NULL
      AND p.archived = FALSE AND COALESCE(p.employee_status, 'Active') = 'Active'
  LOOP
    PERFORM public.payroll_subsidy_refresh(r.id, p_day);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Daily license housekeeping: expiry warnings, recording expiries, and
-- opening / refreshing subsidy rows.
CREATE OR REPLACE FUNCTION public.teacher_license_daily(
  p_today DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days INTEGER := LEAST(365, GREATEST(1, COALESCE((
            SELECT NULLIF(value, '')::INTEGER FROM public.system_config
            WHERE section = 'hr' AND key = 'license_expiry_warning_days'), 60)));
  r      RECORD;
BEGIN
  -- 1. Entering the warning window.
  INSERT INTO public.employee_license_alerts (employee_id, branch_id, kind, license_expires_on)
  SELECT p.id, p.branch_id, 'expiring', p.license_expires_on
  FROM public.profiles p
  WHERE p.is_licensed_teacher AND p.archived = FALSE
    AND p.license_expires_on BETWEEN p_today AND p_today + v_days
  ON CONFLICT DO NOTHING;

  -- 2. Expired and not yet recorded: log it (ends eligibility) and alert HR.
  FOR r IN
    SELECT p.id, p.branch_id, p.license_expires_on
    FROM public.profiles p
    WHERE p.is_licensed_teacher AND p.archived = FALSE
      AND p.license_expires_on < p_today
      AND NOT EXISTS (
        SELECT 1 FROM public.employee_license_changes c
        WHERE c.employee_id = p.id AND c.action = 'expire'
          AND c.effective_on = p.license_expires_on + 1)
  LOOP
    INSERT INTO public.employee_license_changes
      (employee_id, action, effective_on, reason, changed_by_name, changed_by_role)
    VALUES
      (r.id, 'expire', r.license_expires_on + 1,
       'License expired on ' || to_char(r.license_expires_on, 'Mon DD, YYYY'), 'System', 'system');
    INSERT INTO public.employee_license_alerts (employee_id, branch_id, kind, license_expires_on)
    VALUES (r.id, r.branch_id, 'expired', r.license_expires_on)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- 3. Subsidy rows for the current year.
  PERFORM public.payroll_subsidy_open_year(p_today);
END;
$$;

-- 00:30 Manila daily, after the AWOL check (00:20).
SELECT cron.schedule('teacher-license-daily', '30 16 * * *', $$SELECT public.teacher_license_daily();$$);

-- ── 7. Loans (cash advances and subsidy advances included) ─────────────────

CREATE TABLE IF NOT EXISTS public.payroll_loans (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            UUID NOT NULL REFERENCES public.profiles(id),
  branch_id              UUID REFERENCES public.branches(id),
  loan_type              TEXT NOT NULL CHECK (loan_type IN (
                           'salary_loan', 'cash_advance', 'emergency_loan', 'other', 'subsidy_advance')),
  description            TEXT,
  date_granted           DATE NOT NULL,
  principal              NUMERIC(12, 2) NOT NULL CHECK (principal > 0),
  interest_pct           NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (interest_pct BETWEEN 0 AND 100),
  interest_amount        NUMERIC(12, 2) GENERATED ALWAYS AS (round(principal * interest_pct / 100, 2)) STORED,
  total_payable          NUMERIC(12, 2) GENERATED ALWAYS AS (principal + round(principal * interest_pct / 100, 2)) STORED,
  number_of_payrolls     INTEGER CHECK (number_of_payrolls BETWEEN 1 AND 120),
  amortization           NUMERIC(12, 2) CHECK (amortization > 0),
  start_period           DATE CHECK (EXTRACT(DAY FROM start_period) = 16),   -- 2nd half only
  remaining_balance      NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (remaining_balance >= 0),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid', 'suspended')),
  final_pay_authorized   BOOLEAN NOT NULL DEFAULT TRUE,
  subsidy_balance_id     UUID REFERENCES public.payroll_subsidy_balances(id),
  legacy_cash_advance_id UUID UNIQUE REFERENCES public.payroll_cash_advances(id),
  -- Excess subsidy advance (§6.7): converted with consent, or decided by
  -- HR (recommends) and Admin (approves) when consent is refused.
  converted_to_loan_id   UUID REFERENCES public.payroll_loans(id),
  awaiting_decision      BOOLEAN NOT NULL DEFAULT FALSE,
  consent_refused_at     TIMESTAMPTZ,
  decision               TEXT CHECK (decision IN ('offset_next_subsidy', 'waive', 'final_pay', 'collect')),
  decision_reason        TEXT,
  decision_recommended_by      UUID REFERENCES public.profiles(id),
  decision_recommended_by_name TEXT,
  decision_recommended_at      TIMESTAMPTZ,
  decision_approved_by         UUID REFERENCES public.profiles(id),
  decision_approved_by_name    TEXT,
  decision_approved_at         TIMESTAMPTZ,
  status_reason          TEXT,
  status_changed_by      UUID REFERENCES public.profiles(id),
  status_changed_by_name TEXT,
  status_changed_at      TIMESTAMPTZ,
  created_by             UUID REFERENCES public.profiles(id),
  created_by_name        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_loans_kind_chk CHECK (
    CASE WHEN loan_type = 'subsidy_advance'
      -- Taken against the subsidy: no interest, never amortized from salary.
      THEN subsidy_balance_id IS NOT NULL AND interest_pct = 0
           AND amortization IS NULL AND number_of_payrolls IS NULL AND start_period IS NULL
      ELSE subsidy_balance_id IS NULL
           AND amortization IS NOT NULL AND number_of_payrolls IS NOT NULL AND start_period IS NOT NULL
           AND amortization <= principal + round(principal * interest_pct / 100, 2)
    END
  ),
  CONSTRAINT payroll_loans_balance_chk
    CHECK (remaining_balance <= principal + round(principal * interest_pct / 100, 2)),
  -- Only a subsidy advance waits for an HR / Admin decision, and an approved
  -- decision needs both people and a reason.
  CONSTRAINT payroll_loans_decision_chk CHECK (
    (NOT awaiting_decision OR (loan_type = 'subsidy_advance' AND status = 'suspended' AND consent_refused_at IS NOT NULL))
    AND (decision_approved_at IS NULL
         OR (decision IS NOT NULL AND decision_reason IS NOT NULL
             AND decision_recommended_by IS NOT NULL AND decision_approved_by IS NOT NULL))
  )
);

CREATE INDEX IF NOT EXISTS payroll_loans_employee_idx ON public.payroll_loans (employee_id, status, date_granted);
CREATE INDEX IF NOT EXISTS payroll_loans_branch_idx ON public.payroll_loans (branch_id);
CREATE INDEX IF NOT EXISTS payroll_loans_subsidy_idx ON public.payroll_loans (subsidy_balance_id);
CREATE INDEX IF NOT EXISTS payroll_loans_created_by_idx ON public.payroll_loans (created_by);
CREATE INDEX IF NOT EXISTS payroll_loans_status_changed_by_idx ON public.payroll_loans (status_changed_by);

-- Opens a loan; a subsidy advance is checked against, and added to, its
-- subsidy balance.
CREATE OR REPLACE FUNCTION public.payroll_loans_open()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bal    public.payroll_subsidy_balances%ROWTYPE;
  v_cap    NUMERIC(12, 2);
  v_months INTEGER;
BEGIN
  NEW.remaining_balance := NEW.principal + round(NEW.principal * NEW.interest_pct / 100, 2);
  NEW.status := 'active';

  IF NEW.loan_type = 'subsidy_advance' THEN
    SELECT * INTO v_bal FROM public.payroll_subsidy_balances WHERE id = NEW.subsidy_balance_id FOR UPDATE;
    IF NOT FOUND OR v_bal.employee_id <> NEW.employee_id OR v_bal.status <> 'open' THEN
      RAISE EXCEPTION 'No open subsidy balance for this teacher.';
    END IF;
    IF NOT public.teacher_subsidy_eligible_on(NEW.employee_id, NEW.date_granted)
       OR (SELECT payroll_hold FROM public.profiles WHERE id = NEW.employee_id) THEN
      RAISE EXCEPTION 'Only an eligible licensed teacher (verified, unexpired) who is not on payroll hold can take a subsidy advance.';
    END IF;
    IF NEW.date_granted NOT BETWEEN v_bal.subsidy_year_start AND v_bal.subsidy_year_end THEN
      RAISE EXCEPTION 'The advance date is outside the subsidy year % – %.', v_bal.subsidy_year_start, v_bal.subsidy_year_end;
    END IF;

    v_cap := v_bal.remaining;
    IF v_bal.advance_limit = 'earned_to_date' THEN
      -- Months from eligibility through the advance month.
      v_months := GREATEST(0,
        (EXTRACT(YEAR FROM NEW.date_granted) * 12 + EXTRACT(MONTH FROM NEW.date_granted))
        - (EXTRACT(YEAR FROM v_bal.eligible_from) * 12 + EXTRACT(MONTH FROM v_bal.eligible_from)) + 1)::INTEGER;
      v_cap := LEAST(v_cap,
        round(v_bal.annual_amount * LEAST(v_months, v_bal.eligible_months) / 12.0, 2)
        - v_bal.advances_total - v_bal.paid_out);
    END IF;
    IF NEW.principal > v_cap THEN
      RAISE EXCEPTION 'The advance % is more than the subsidy balance available (%).', NEW.principal, GREATEST(v_cap, 0)
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.payroll_subsidy_balances
    SET advances_total = advances_total + NEW.principal, updated_at = NOW()
    WHERE id = v_bal.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_loans_open ON public.payroll_loans;
CREATE TRIGGER payroll_loans_open
  BEFORE INSERT ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.payroll_loans_open();

CREATE TABLE IF NOT EXISTS public.payroll_loan_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id             UUID NOT NULL REFERENCES public.payroll_loans(id),
  employee_id         UUID NOT NULL REFERENCES public.profiles(id),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'payroll', 'final_pay', 'manual', 'subsidy_offset', 'converted', 'waiver', 'reversal')),
  period_start        DATE,            -- the 2nd-half period, for 'payroll'
  pay_period          TEXT,            -- payroll_entries.pay_period label
  payroll_entry_id    UUID,            -- the Final payslip / final pay it came from
  amount_due          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  amount              NUMERIC(12, 2) NOT NULL,   -- negative only for a reversal
  balance_before      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  balance_after       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reverses_payment_id UUID UNIQUE REFERENCES public.payroll_loan_payments(id),
  reversed            BOOLEAN NOT NULL DEFAULT FALSE,
  note                TEXT,
  created_by          UUID REFERENCES public.profiles(id),
  created_by_name     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_loan_payments_kind_chk CHECK (
    (kind = 'reversal') = (reverses_payment_id IS NOT NULL)
    AND (kind = 'reversal' OR amount >= 0)
    AND (kind <> 'payroll' OR period_start IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_loan_payments_one_per_period
  ON public.payroll_loan_payments (loan_id, period_start)
  WHERE kind = 'payroll' AND NOT reversed;
CREATE INDEX IF NOT EXISTS payroll_loan_payments_employee_idx
  ON public.payroll_loan_payments (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_loan_payments_created_by_idx
  ON public.payroll_loan_payments (created_by);

-- Applies a payment: never more than the balance; ₱0 balance = paid.
CREATE OR REPLACE FUNCTION public.payroll_loan_payments_apply()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_loan public.payroll_loans%ROWTYPE;
  v_orig public.payroll_loan_payments%ROWTYPE;
BEGIN
  SELECT * INTO v_loan FROM public.payroll_loans WHERE id = NEW.loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan % not found.', NEW.loan_id;
  END IF;
  NEW.employee_id := v_loan.employee_id;

  IF NEW.kind = 'reversal' THEN
    SELECT * INTO v_orig FROM public.payroll_loan_payments WHERE id = NEW.reverses_payment_id FOR UPDATE;
    IF NOT FOUND OR v_orig.loan_id <> NEW.loan_id OR v_orig.kind = 'reversal' OR v_orig.reversed THEN
      RAISE EXCEPTION 'Only a live payment of this loan can be reversed.';
    END IF;
    NEW.amount := -v_orig.amount;
    NEW.amount_due := 0;
    UPDATE public.payroll_loan_payments SET reversed = TRUE WHERE id = v_orig.id;
  ELSE
    IF NEW.kind = 'payroll' AND (v_loan.status <> 'active' OR v_loan.loan_type = 'subsidy_advance') THEN
      RAISE EXCEPTION 'Payroll does not deduct loan % (% / %).', NEW.loan_id, v_loan.loan_type, v_loan.status;
    END IF;
    IF NEW.kind = 'subsidy_offset' AND v_loan.loan_type <> 'subsidy_advance' THEN
      RAISE EXCEPTION 'Only a subsidy advance is settled by the subsidy.';
    END IF;
    IF NEW.kind = 'subsidy_offset' AND v_loan.awaiting_decision
       AND v_loan.decision IS DISTINCT FROM 'offset_next_subsidy' THEN
      RAISE EXCEPTION 'Loan % awaits an HR / Admin decision.', NEW.loan_id;
    END IF;
    IF NEW.kind = 'converted' AND v_loan.converted_to_loan_id IS NULL THEN
      RAISE EXCEPTION 'Create the signed replacement loan before converting loan %.', NEW.loan_id;
    END IF;
    IF NEW.kind = 'waiver' AND (v_loan.decision IS DISTINCT FROM 'waive' OR v_loan.decision_approved_at IS NULL
                                OR length(trim(COALESCE(NEW.note, ''))) = 0) THEN
      RAISE EXCEPTION 'A waiver needs an approved HR / Admin decision and a note.';
    END IF;
    IF NEW.kind = 'final_pay' AND v_loan.awaiting_decision
       AND (v_loan.decision IS DISTINCT FROM 'final_pay' OR v_loan.decision_approved_at IS NULL) THEN
      RAISE EXCEPTION 'Loan % awaits an HR / Admin decision.', NEW.loan_id;
    END IF;
    IF NEW.kind = 'final_pay' AND NOT v_loan.final_pay_authorized THEN
      RAISE EXCEPTION 'Loan % has no signed authority to deduct from final pay.', NEW.loan_id;
    END IF;
    IF NEW.amount > v_loan.remaining_balance THEN
      RAISE EXCEPTION 'Payment % is more than the remaining balance %.', NEW.amount, v_loan.remaining_balance
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.balance_before := v_loan.remaining_balance;
  NEW.balance_after  := v_loan.remaining_balance - NEW.amount;

  UPDATE public.payroll_loans
  SET remaining_balance = NEW.balance_after,
      -- A cleared balance means any HR / Admin decision has been carried out.
      awaiting_decision = CASE WHEN NEW.balance_after = 0 THEN FALSE ELSE awaiting_decision END,
      status = CASE
                 WHEN NEW.balance_after = 0 THEN 'paid'
                 WHEN status = 'paid' THEN 'active'
                 ELSE status
               END,
      status_reason = CASE
                        WHEN NEW.balance_after = 0 THEN 'Fully paid'
                        WHEN status = 'paid' THEN 'Reopened by a reversed payment'
                        ELSE status_reason
                      END,
      status_changed_at = CASE
                            WHEN (NEW.balance_after = 0) <> (status = 'paid') THEN NOW()
                            ELSE status_changed_at
                          END
  WHERE id = v_loan.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_loan_payments_apply ON public.payroll_loan_payments;
CREATE TRIGGER payroll_loan_payments_apply
  BEFORE INSERT ON public.payroll_loan_payments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_loan_payments_apply();

-- Payslip line types ('cash_advance' stays for old payslips).
ALTER TABLE public.payroll_deductions DROP CONSTRAINT IF EXISTS payroll_deductions_type_check;
ALTER TABLE public.payroll_deductions ADD CONSTRAINT payroll_deductions_type_check CHECK (type IN (
  'late', 'undertime', 'half_day', 'absent', 'leave_without_pay',
  'sss', 'philhealth', 'pagibig', 'withholding_tax', 'carry_over', 'cash_advance',
  'loan', 'unpaid_holiday'
));

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type IN (
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium', 'incentive', 'overload',
  'subsidy', 'subsidy_adjustment'
));

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_traceable_chk;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_traceable_chk CHECK (
  is_override
  OR type IN ('incentive', 'overload', 'subsidy', 'subsidy_adjustment')
  OR source_log_id IS NOT NULL
  OR COALESCE(array_length(source_log_ids, 1), 0) > 0
);

-- Missed subsidy months (no backdating, decision 15): Accountant requests,
-- Admin approves with a reason, paid once on a later 2nd-half payslip.
CREATE TABLE IF NOT EXISTS public.payroll_subsidy_adjustments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          UUID NOT NULL REFERENCES public.profiles(id),
  subsidy_balance_id   UUID NOT NULL REFERENCES public.payroll_subsidy_balances(id),
  months_missed        SMALLINT NOT NULL CHECK (months_missed BETWEEN 1 AND 12),
  months_label         TEXT NOT NULL,                  -- e.g. 'May–Jul 2027', shown on the payslip
  amount               NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  requested_by         UUID REFERENCES public.profiles(id),
  requested_by_name    TEXT,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by           UUID REFERENCES public.profiles(id),
  decided_by_name      TEXT,
  decided_by_role      TEXT CHECK (decided_by_role = 'admin'),
  decided_at           TIMESTAMPTZ,
  decision_note        TEXT,
  applied_period_start DATE CHECK (EXTRACT(DAY FROM applied_period_start) = 16),
  payroll_entry_id     UUID,
  applied_at           TIMESTAMPTZ,
  CONSTRAINT payroll_subsidy_adjustments_decided_chk CHECK (
    status = 'pending'
    OR (decided_by IS NOT NULL AND decided_by_role = 'admin' AND decided_at IS NOT NULL)
  ),
  CONSTRAINT payroll_subsidy_adjustments_applied_chk CHECK (
    (status = 'applied') = (payroll_entry_id IS NOT NULL AND applied_period_start IS NOT NULL AND applied_at IS NOT NULL)
  ),
  CONSTRAINT payroll_subsidy_adjustments_two_people_chk CHECK (
    decided_by IS NULL OR decided_by IS DISTINCT FROM requested_by
  )
);

CREATE INDEX IF NOT EXISTS payroll_subsidy_adjustments_employee_idx
  ON public.payroll_subsidy_adjustments (employee_id, status);
CREATE INDEX IF NOT EXISTS payroll_subsidy_adjustments_balance_idx
  ON public.payroll_subsidy_adjustments (subsidy_balance_id);

-- Caps the amount and the months; only pending → approved / rejected and
-- approved → applied; nothing else changes after the request.
CREATE OR REPLACE FUNCTION public.payroll_subsidy_adjustments_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  b       public.payroll_subsidy_balances%ROWTYPE;
  v_other INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'An adjustment starts as pending.';
    END IF;
    SELECT * INTO b FROM public.payroll_subsidy_balances WHERE id = NEW.subsidy_balance_id FOR UPDATE;
    IF NOT FOUND OR b.employee_id <> NEW.employee_id THEN
      RAISE EXCEPTION 'The subsidy balance does not belong to this teacher.';
    END IF;
    SELECT COALESCE(SUM(a.months_missed), 0) INTO v_other
    FROM public.payroll_subsidy_adjustments a
    WHERE a.subsidy_balance_id = b.id AND a.status <> 'rejected';
    IF b.eligible_months + v_other + NEW.months_missed > 12 THEN
      RAISE EXCEPTION 'Counted and adjusted months cannot exceed 12 (counted %, already adjusted %).', b.eligible_months, v_other;
    END IF;
    IF NEW.amount > round(b.annual_amount * NEW.months_missed / 12.0, 2) THEN
      RAISE EXCEPTION 'The adjustment is more than % month(s) of the % subsidy.', NEW.months_missed, b.annual_amount;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Adjustments are never deleted; reject it instead.' USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW.employee_id, NEW.subsidy_balance_id, NEW.months_missed, NEW.months_label, NEW.amount, NEW.reason,
      NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.employee_id, OLD.subsidy_balance_id, OLD.months_missed, OLD.months_label, OLD.amount, OLD.reason,
      OLD.requested_by, OLD.requested_at)
     OR NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
             OR (OLD.status = 'approved' AND NEW.status = 'applied')) THEN
    RAISE EXCEPTION 'An adjustment only moves pending → approved / rejected → applied; the request itself never changes.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_subsidy_adjustments_guard ON public.payroll_subsidy_adjustments;
CREATE TRIGGER payroll_subsidy_adjustments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_subsidy_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_subsidy_adjustments_guard();

-- Payments counted toward the exempt ceiling (decision 10), per employee
-- and calendar tax year, by the date paid: the 13th month plus subsidy
-- advances and payouts flagged "other benefit".
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
  WHERE a.status = 'applied' AND b.tax_treatment = 'other_benefit';

-- ── 8. Employee status, payroll hold, AWOL cases ───────────────────────────
-- employee_status gains 'AWOL' and 'Separated'. Live allows only Active /
-- Pending / Archived (profiles_employee_status_check); those stay.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employee_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_employee_status_check
  CHECK (employee_status = ANY (ARRAY['Active', 'Pending', 'Archived', 'AWOL', 'Separated']));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS payroll_hold        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payroll_hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS separated_on        DATE,
  ADD COLUMN IF NOT EXISTS separation_reason   TEXT;

CREATE TABLE IF NOT EXISTS public.employee_awol_cases (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            UUID NOT NULL REFERENCES public.profiles(id),
  branch_id              UUID REFERENCES public.branches(id),
  first_absent_on        DATE NOT NULL,
  last_present_on        DATE,
  stage                  TEXT NOT NULL DEFAULT 'flagged' CHECK (stage IN (
                           'flagged', 'confirmed', 'first_notice', 'second_notice', 'for_decision', 'closed')),
  outcome                TEXT CHECK (outcome IN ('false_alarm', 'returned', 'excused_by_leave', 'separated')),
  flagged_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at           TIMESTAMPTZ,
  confirmed_by           UUID REFERENCES public.profiles(id),
  confirmed_by_name      TEXT,
  first_notice_sent_on   DATE,
  first_notice_reply_by  DATE,
  second_notice_sent_on  DATE,
  second_notice_reply_by DATE,
  conference_on          DATE,
  employee_reply         TEXT,
  recommendation         TEXT,
  recommended_at         TIMESTAMPTZ,
  recommended_by         UUID REFERENCES public.profiles(id),
  recommended_by_name    TEXT,
  decided_at             TIMESTAMPTZ,
  decided_by             UUID REFERENCES public.profiles(id),
  decided_by_name        TEXT,
  separation_effective   DATE,
  returned_on            DATE,
  leave_request_id       TEXT REFERENCES public.leave_requests(id),   -- leave_requests.id is TEXT on live
  final_pay_computed_at  TIMESTAMPTZ,
  final_pay_released_on  DATE,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_awol_cases_closed_chk CHECK ((stage = 'closed') = (outcome IS NOT NULL)),
  CONSTRAINT employee_awol_cases_separated_chk CHECK (
    outcome IS DISTINCT FROM 'separated'
    OR (separation_effective IS NOT NULL AND decided_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_awol_cases_one_open
  ON public.employee_awol_cases (employee_id) WHERE stage <> 'closed';
CREATE INDEX IF NOT EXISTS employee_awol_cases_branch_idx ON public.employee_awol_cases (branch_id, stage);

CREATE TABLE IF NOT EXISTS public.employee_status_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES public.profiles(id),
  old_status      TEXT,
  new_status      TEXT NOT NULL,
  effective_on    DATE NOT NULL,
  reason          TEXT,
  awol_case_id    UUID REFERENCES public.employee_awol_cases(id),
  changed_by      UUID,
  changed_by_name TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employee_status_changes_employee_idx
  ON public.employee_status_changes (employee_id, changed_at DESC);

-- AWOL / Separated hold pay; AWOL → Active lifts it. Separated never
-- lifts it: the held periods are paid only through final pay.
CREATE OR REPLACE FUNCTION public.profiles_payroll_hold_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.employee_status IS DISTINCT FROM OLD.employee_status THEN
    IF NEW.employee_status = 'AWOL' THEN
      NEW.payroll_hold := TRUE;
      NEW.payroll_hold_reason := 'AWOL: pay held until HR closes the case';
    ELSIF NEW.employee_status = 'Separated' THEN
      NEW.payroll_hold := TRUE;
      NEW.payroll_hold_reason := 'Separated: paid through final pay only';
    ELSIF OLD.employee_status = 'AWOL' AND NEW.employee_status = 'Active' THEN
      NEW.payroll_hold := FALSE;
      NEW.payroll_hold_reason := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_payroll_hold_sync ON public.profiles;
CREATE TRIGGER profiles_payroll_hold_sync
  BEFORE UPDATE OF employee_status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_payroll_hold_sync();

-- Nightly: open a case for N consecutive working-day absences with no leave
-- filed (any leave not rejected). N = system_config hr.awol_flag_days (3).
INSERT INTO public.system_config (section, key, value, updated_by)
VALUES ('hr', 'awol_flag_days', '3', 'System (AWOL policy)')
ON CONFLICT (section, key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.awol_flag_candidates(
  p_through DATE DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::DATE - 1)
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days  INTEGER := GREATEST(1, COALESCE((
            SELECT NULLIF(value, '')::INTEGER FROM public.system_config
            WHERE section = 'hr' AND key = 'awol_flag_days'), 3));
  v_count INTEGER;
BEGIN
  WITH working AS (
    SELECT l.employee_id, l.log_date, l.status,
           row_number() OVER (PARTITION BY l.employee_id ORDER BY l.log_date DESC) AS rn
    FROM public.attendance_logs l
    WHERE l.log_date BETWEEN p_through - 30 AND p_through
      AND NOT public.attendance_is_rest_day(l.log_date)
  ), streaks AS (
    SELECT w.employee_id, MIN(w.log_date) AS first_absent
    FROM working w
    WHERE w.rn <= v_days
    GROUP BY w.employee_id
    HAVING COUNT(*) = v_days AND bool_and(w.status = 'Absent')
  ), opened AS (
    INSERT INTO public.employee_awol_cases (employee_id, branch_id, first_absent_on, last_present_on)
    SELECT s.employee_id, p.branch_id, s.first_absent,
           (SELECT MAX(l.log_date) FROM public.attendance_logs l
            WHERE l.employee_id = s.employee_id AND l.log_date < s.first_absent
              AND l.status NOT IN ('Absent', 'Holiday', 'On Leave'))
    FROM streaks s
    JOIN public.profiles p ON p.id = s.employee_id
    WHERE p.archived = FALSE
      AND COALESCE(p.employee_status, 'Active') = 'Active'
      -- leave_requests.employee_id is UUID and its dates are TEXT on live:
      -- compare as text / cast only well-formed dates, never fail the job.
      AND NOT EXISTS (
        SELECT 1 FROM public.leave_requests r
        WHERE r.employee_id::TEXT = s.employee_id::TEXT
          AND lower(r.status) NOT IN ('rejected', 'cancelled', 'denied')
          AND (CASE WHEN r.start_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.start_date::TEXT::DATE END) <= p_through
          AND (CASE WHEN r.end_date::TEXT ~ '^\d{4}-\d{2}-\d{2}$' THEN r.end_date::TEXT::DATE END) >= s.first_absent)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM opened;
  RETURN v_count;
END;
$$;

-- 00:20 Manila, after the nightly attendance close (00:05).
SELECT cron.schedule('awol-flag-candidates', '20 16 * * *', $$SELECT public.awol_flag_candidates();$$);

-- ── 9. Access: server (service role) only; history is never deleted ───────

ALTER TABLE public.payroll_setting_changes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_schedule_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_subsidy_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_subsidy_balances  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_license_changes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_license_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_license_alerts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_subsidy_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_loans             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_loan_payments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_awol_cases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_status_changes   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_setting_changes   FROM anon, authenticated;
REVOKE ALL ON public.payroll_schedule_settings FROM anon, authenticated;
REVOKE ALL ON public.payroll_subsidy_settings  FROM anon, authenticated;
REVOKE ALL ON public.payroll_subsidy_balances  FROM anon, authenticated;
REVOKE ALL ON public.employee_license_changes  FROM anon, authenticated;
REVOKE ALL ON public.employee_license_documents FROM anon, authenticated;
REVOKE ALL ON public.employee_license_alerts   FROM anon, authenticated;
REVOKE ALL ON public.payroll_subsidy_adjustments FROM anon, authenticated;
REVOKE ALL ON public.payroll_exempt_benefits_paid FROM anon, authenticated;
REVOKE ALL ON public.payroll_loans             FROM anon, authenticated;
REVOKE ALL ON public.payroll_loan_payments     FROM anon, authenticated;
REVOKE ALL ON public.employee_awol_cases       FROM anon, authenticated;
REVOKE ALL ON public.employee_status_changes   FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.payroll_append_only() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_generation_date_for(DATE, SMALLINT, SMALLINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_schedule_for(DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_schedule_settings_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_subsidy_year_for(DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_subsidy_settings_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_settings_log() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.employee_license_changes_apply() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.employee_license_changes_refresh_subsidy() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.profiles_license_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.teacher_subsidy_eligible_on(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.teacher_subsidy_months(UUID, DATE, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_subsidy_refresh(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_subsidy_open_year(DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.teacher_license_daily(DATE) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_subsidy_adjustments_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_loans_open() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_loan_payments_apply() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.profiles_payroll_hold_sync() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.awol_flag_candidates(DATE) FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_subsidy_balances_block_hard_delete ON public.payroll_subsidy_balances;
CREATE TRIGGER payroll_subsidy_balances_block_hard_delete
  BEFORE DELETE ON public.payroll_subsidy_balances
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS employee_license_changes_append_only ON public.employee_license_changes;
CREATE TRIGGER employee_license_changes_append_only
  BEFORE UPDATE OR DELETE ON public.employee_license_changes
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only();

DROP TRIGGER IF EXISTS employee_license_documents_append_only ON public.employee_license_documents;
CREATE TRIGGER employee_license_documents_append_only
  BEFORE UPDATE OR DELETE ON public.employee_license_documents
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only();

DROP TRIGGER IF EXISTS employee_license_alerts_block_hard_delete ON public.employee_license_alerts;
CREATE TRIGGER employee_license_alerts_block_hard_delete
  BEFORE DELETE ON public.employee_license_alerts
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS payroll_loans_block_hard_delete ON public.payroll_loans;
CREATE TRIGGER payroll_loans_block_hard_delete
  BEFORE DELETE ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS payroll_loan_payments_block_hard_delete ON public.payroll_loan_payments;
CREATE TRIGGER payroll_loan_payments_block_hard_delete
  BEFORE DELETE ON public.payroll_loan_payments
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS employee_awol_cases_block_hard_delete ON public.employee_awol_cases;
CREATE TRIGGER employee_awol_cases_block_hard_delete
  BEFORE DELETE ON public.employee_awol_cases
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();

DROP TRIGGER IF EXISTS employee_status_changes_append_only ON public.employee_status_changes;
CREATE TRIGGER employee_status_changes_append_only
  BEFORE UPDATE OR DELETE ON public.employee_status_changes
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only();
