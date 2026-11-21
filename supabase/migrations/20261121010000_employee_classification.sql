-- ════════════════════════════════════════════════════════════════════════════
-- Part A (panel revisions, 2026-11-20): employee category, employment status
-- and employment type.
--
--  * profiles.employment_status (Regular | Probationary | Contractual) and
--    profiles.employment_type (Full-time | Part-time) become columns (they were
--    only in the account metadata), with profiles.contract_end_date and
--    profiles.classification_unconfirmed ("Needs HR confirmation").
--    "Substitute" is not a status: the school uses its own employees as
--    substitutes (Part C).
--  * employee_classification_changes: effective-dated history of category,
--    status, type, on-payroll and contract end date (who, when, why). A change
--    takes effect on its date (employee_classification_apply, nightly 00:00
--    Manila, before the 00:05 close); payroll reads the value in effect on
--    each date from this history.
--  * statutory_leave_types: maternity, paternity (and others, off by default)
--    filed per event with eligibility; not yearly credits.
--  * leave_credit_rules: days per year by leave type × category × status ×
--    type (versioned by effective_from); leave_credit_overrides: per employee
--    and year, with a reason. Defaults are marked "pending policy manual".
--  * employee_pay_rules: pay basis, overtime, and eligibility for subsidies,
--    incentives and loans per category × status × type (versioned).
--  * employee_hr_reminders + employee_hr_reminders_run(): HR is reminded N days
--    (setting, 30) before a probationary employee reaches N months (setting, 6)
--    and before a contract ends. Nightly 00:40 Manila.
--
-- Data: the payroll accounts without a status or type get Regular / Full-time,
-- marked "Needs HR confirmation"; Payroll JM (SACS-ACCT-001) is Non-Teaching.
-- ════════════════════════════════════════════════════════════════════════════

-- ── profile columns ─────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS employment_status TEXT,
  ADD COLUMN IF NOT EXISTS employment_type TEXT,
  ADD COLUMN IF NOT EXISTS contract_end_date DATE,
  ADD COLUMN IF NOT EXISTS classification_unconfirmed BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill from the account metadata (where the app kept them until now).
UPDATE public.profiles p
SET employment_status = CASE WHEN u.raw_user_meta_data->>'employment_status' IN ('Regular', 'Probationary', 'Contractual')
                             THEN u.raw_user_meta_data->>'employment_status' END,
    employment_type = CASE WHEN u.raw_user_meta_data->>'employment_type' IN ('Full-time', 'Part-time')
                           THEN u.raw_user_meta_data->>'employment_type' END
FROM auth.users u
WHERE u.id = p.id AND p.employment_status IS NULL AND p.employment_type IS NULL;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employment_status_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_employment_status_valid
  CHECK (employment_status IS NULL OR employment_status IN ('Regular', 'Probationary', 'Contractual'));
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employment_type_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_employment_type_valid
  CHECK (employment_type IS NULL OR employment_type IN ('Full-time', 'Part-time'));

-- Payroll accounts still without a status or type: Regular / Full-time, for HR to confirm.
UPDATE public.profiles
SET employment_status = COALESCE(employment_status, 'Regular'),
    employment_type = COALESCE(employment_type, 'Full-time'),
    classification_unconfirmed = TRUE,
    updated_at = NOW()
WHERE lower(role::TEXT) IN ('employee', 'accountant', 'hr') AND on_payroll AND NOT COALESCE(archived, FALSE)
  AND (employment_status IS NULL OR employment_type IS NULL);

-- An Accountant is not a teacher (decision 2026-11-20).
UPDATE public.profiles SET employee_type = 'Non-Teaching', updated_at = NOW()
WHERE employee_id = 'SACS-ACCT-001' AND employee_type = 'Teaching';

-- Keep the account metadata (what most screens read) in step.
UPDATE auth.users u
SET raw_user_meta_data = COALESCE(u.raw_user_meta_data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'employee_type', p.employee_type, 'employment_status', p.employment_status, 'employment_type', p.employment_type))
FROM public.profiles p
WHERE p.id = u.id AND (
  u.raw_user_meta_data->>'employment_status' IS DISTINCT FROM p.employment_status
  OR u.raw_user_meta_data->>'employment_type' IS DISTINCT FROM p.employment_type
  OR (p.employee_type IS NOT NULL AND u.raw_user_meta_data->>'employee_type' IS DISTINCT FROM p.employee_type));

-- ── effective-dated history ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_classification_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES public.profiles(id),
  field           TEXT NOT NULL CHECK (field IN ('employee_type', 'employment_status', 'employment_type', 'on_payroll', 'contract_end_date')),
  old_value       TEXT,
  new_value       TEXT,
  effective_on    DATE NOT NULL,
  reason          TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  applied_at      TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  changed_by      UUID,
  changed_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_classification_changes_value_set CHECK (field = 'contract_end_date' OR new_value IS NOT NULL),
  CONSTRAINT employee_classification_changes_value_chk CHECK (
    (field = 'employee_type' AND new_value IN ('Teaching', 'Non-Teaching'))
    OR (field = 'employment_status' AND new_value IN ('Regular', 'Probationary', 'Contractual'))
    OR (field = 'employment_type' AND new_value IN ('Full-time', 'Part-time'))
    OR (field = 'on_payroll' AND new_value IN ('true', 'false'))
    OR (field = 'contract_end_date' AND (new_value IS NULL OR new_value ~ '^\d{4}-\d{2}-\d{2}$')))
);
CREATE INDEX IF NOT EXISTS employee_classification_changes_employee_idx
  ON public.employee_classification_changes (employee_id, field, effective_on);
CREATE INDEX IF NOT EXISTS employee_classification_changes_due_idx
  ON public.employee_classification_changes (effective_on) WHERE applied_at IS NULL AND cancelled_at IS NULL;

-- Applies every change due on or before p_today, oldest first. Idempotent.
CREATE OR REPLACE FUNCTION public.employee_classification_apply(
  p_today DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.employee_classification_changes
    WHERE applied_at IS NULL AND cancelled_at IS NULL AND effective_on <= p_today
    ORDER BY effective_on, created_at
    FOR UPDATE
  LOOP
    IF r.field = 'employee_type' THEN
      UPDATE public.profiles SET employee_type = r.new_value, updated_at = NOW() WHERE id = r.employee_id;
    ELSIF r.field = 'employment_status' THEN
      UPDATE public.profiles SET employment_status = r.new_value, classification_unconfirmed = FALSE, updated_at = NOW() WHERE id = r.employee_id;
    ELSIF r.field = 'employment_type' THEN
      UPDATE public.profiles SET employment_type = r.new_value, classification_unconfirmed = FALSE, updated_at = NOW() WHERE id = r.employee_id;
    ELSIF r.field = 'on_payroll' THEN
      UPDATE public.profiles SET on_payroll = (r.new_value = 'true'), updated_at = NOW() WHERE id = r.employee_id;
    ELSIF r.field = 'contract_end_date' THEN
      UPDATE public.profiles SET contract_end_date = r.new_value::DATE, updated_at = NOW() WHERE id = r.employee_id;
    END IF;
    UPDATE auth.users
    SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object(r.field, CASE WHEN r.field = 'on_payroll' THEN to_jsonb(r.new_value = 'true') ELSE to_jsonb(r.new_value) END)
    WHERE id = r.employee_id;
    UPDATE public.employee_classification_changes SET applied_at = NOW() WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── leave credit rules ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leave_credit_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_type        TEXT NOT NULL CHECK (leave_type IN ('Vacation Leave', 'Sick Leave', 'Emergency Leave')),
  employee_type     TEXT NOT NULL CHECK (employee_type IN ('Teaching', 'Non-Teaching')),
  employment_status TEXT NOT NULL CHECK (employment_status IN ('Regular', 'Probationary', 'Contractual')),
  employment_type   TEXT NOT NULL CHECK (employment_type IN ('Full-time', 'Part-time')),
  days_per_year     NUMERIC(6, 2) NOT NULL CHECK (days_per_year BETWEEN 0 AND 366),
  effective_from    DATE NOT NULL,
  note              TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  created_by        UUID,
  created_by_name   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (leave_type, employee_type, employment_status, employment_type, effective_from)
);

CREATE TABLE IF NOT EXISTS public.leave_credit_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES public.profiles(id),
  leave_type      TEXT NOT NULL CHECK (leave_type IN ('Vacation Leave', 'Sick Leave', 'Emergency Leave')),
  year            INTEGER NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  days            NUMERIC(6, 2) NOT NULL CHECK (days BETWEEN 0 AND 366),
  reason          TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  created_by      UUID,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS leave_credit_overrides_employee_idx ON public.leave_credit_overrides (employee_id, year, leave_type, created_at DESC);

-- Defaults, pending the school's policy manual: the same for every
-- combination (5 vacation, 5 sick, 3 emergency) so nobody has fewer paid days
-- than under the shared 6-day pool for the leave they file most; HR sets the
-- school's own differences. Maternity and paternity are NOT yearly credits:
-- they are statutory leaves filed per event (statutory_leave_types below).
INSERT INTO public.leave_credit_rules (leave_type, employee_type, employment_status, employment_type, days_per_year, effective_from, note, created_by_name)
SELECT lt.leave_type, et.v, es.v, ty.v, lt.days, DATE '2026-01-01', 'Default: pending policy manual', 'System'
FROM (VALUES ('Vacation Leave', 5), ('Sick Leave', 5), ('Emergency Leave', 3)) lt(leave_type, days)
CROSS JOIN (VALUES ('Teaching'), ('Non-Teaching')) et(v)
CROSS JOIN (VALUES ('Regular'), ('Probationary'), ('Contractual')) es(v)
CROSS JOIN (VALUES ('Full-time'), ('Part-time')) ty(v)
ON CONFLICT DO NOTHING;

-- Statutory leaves, filed per event (or per year) when the employee is
-- eligible; HR approves them like other leave. Days are settings, pending the
-- policy manual. Maternity and paternity are on; the others off until the
-- school turns them on.
CREATE TABLE IF NOT EXISTS public.statutory_leave_types (
  leave_type      TEXT PRIMARY KEY CHECK (char_length(leave_type) BETWEEN 3 AND 64),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  days            NUMERIC(6, 2) NOT NULL CHECK (days > 0 AND days <= 366),
  basis           TEXT NOT NULL CHECK (basis IN ('event', 'year')),
  eligibility     TEXT NOT NULL CHECK (eligibility IN ('female', 'married_male', 'any')),
  max_events      INTEGER CHECK (max_events IS NULL OR max_events BETWEEN 1 AND 50),
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.statutory_leave_types (leave_type, enabled, days, basis, eligibility, max_events, note, sort_order, updated_by_name) VALUES
  ('Maternity Leave', TRUE, 105, 'event', 'female', NULL, 'Per pregnancy or childbirth (RA 11210); the SSS maternity benefit applies. Days pending policy manual.', 1, 'System'),
  ('Paternity Leave', TRUE, 7, 'event', 'married_male', 4, 'Per delivery of the lawful wife, the first 4 deliveries (RA 8187). Days pending policy manual.', 2, 'System'),
  ('Solo Parent Leave', FALSE, 7, 'year', 'any', NULL, 'For a solo parent with a Solo Parent ID (RA 11861). Off until the school turns it on.', 3, 'System'),
  ('VAWC Leave', FALSE, 10, 'year', 'female', NULL, 'For a woman victim of violence or her child (RA 9262). Off until the school turns it on.', 4, 'System'),
  ('Special Leave for Women', FALSE, 60, 'event', 'female', NULL, 'After surgery for a gynecological disorder, up to 2 months (RA 9710). Off until the school turns it on.', 5, 'System')
ON CONFLICT (leave_type) DO NOTHING;

-- ── pay rules per combination ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_pay_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_type      TEXT NOT NULL CHECK (employee_type IN ('Teaching', 'Non-Teaching')),
  employment_status  TEXT NOT NULL CHECK (employment_status IN ('Regular', 'Probationary', 'Contractual')),
  employment_type    TEXT NOT NULL CHECK (employment_type IN ('Full-time', 'Part-time')),
  pay_basis          TEXT NOT NULL CHECK (pay_basis IN ('monthly', 'hourly', 'scheduled_hours')),
  overtime_allowed   BOOLEAN NOT NULL DEFAULT TRUE,
  subsidy_eligible   BOOLEAN NOT NULL DEFAULT TRUE,
  incentive_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  loan_eligible      BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from     DATE NOT NULL,
  note               TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  created_by         UUID,
  created_by_name    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_type, employment_status, employment_type, effective_from),
  CHECK (employment_type = 'Part-time' OR pay_basis = 'monthly')
);

INSERT INTO public.employee_pay_rules (employee_type, employment_status, employment_type, pay_basis, effective_from, note, created_by_name)
SELECT et.v, es.v, ty.v, CASE WHEN ty.v = 'Part-time' THEN 'hourly' ELSE 'monthly' END,
  DATE '2026-01-01', 'Default: pending policy manual', 'System'
FROM (VALUES ('Teaching'), ('Non-Teaching')) et(v)
CROSS JOIN (VALUES ('Regular'), ('Probationary'), ('Contractual')) es(v)
CROSS JOIN (VALUES ('Full-time'), ('Part-time')) ty(v)
ON CONFLICT DO NOTHING;

-- ── settings (pending policy manual) ────────────────────────────────────────
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'hr', v.key, v.value, 'System'
FROM (VALUES ('probation_months', '6'), ('probation_reminder_days', '30'), ('contract_reminder_days', '30'),
             ('full_time_weekly_hours', '40')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'hr' AND c.key = v.key);

-- ── HR reminders ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_hr_reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.profiles(id),
  kind        TEXT NOT NULL CHECK (kind IN ('probation_end', 'contract_end')),
  due_on      DATE NOT NULL,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, kind, due_on)
);

-- The day a probationary employee completes the probation: N months after the
-- latest change to Probationary (or the hire date when there is none).
CREATE OR REPLACE FUNCTION public.employee_probation_end(p_employee UUID)
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (COALESCE(
      (SELECT MAX(c.effective_on) FROM public.employee_classification_changes c
       WHERE c.employee_id = p.id AND c.field = 'employment_status' AND c.new_value = 'Probationary' AND c.cancelled_at IS NULL),
      p.date_hired, p.created_at::DATE)
    + make_interval(months => COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'probation_months'), 6)))::DATE
  FROM public.profiles p
  WHERE p.id = p_employee AND p.employment_status = 'Probationary';
$$;

CREATE OR REPLACE FUNCTION public.employee_hr_reminders_run(
  p_today DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Manila')::DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prob_days INTEGER := COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'probation_reminder_days'), 30);
  v_contract_days INTEGER := COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'contract_reminder_days'), 30);
  v_count INTEGER;
BEGIN
  WITH due AS (
    SELECT p.id, p.full_name, 'probation_end'::TEXT AS kind, public.employee_probation_end(p.id) AS due_on
    FROM public.profiles p
    WHERE p.employment_status = 'Probationary' AND NOT COALESCE(p.archived, FALSE) AND p.on_payroll
    UNION ALL
    SELECT p.id, p.full_name, 'contract_end', p.contract_end_date
    FROM public.profiles p
    WHERE p.contract_end_date IS NOT NULL AND NOT COALESCE(p.archived, FALSE) AND p.on_payroll
  ), fresh AS (
    INSERT INTO public.employee_hr_reminders (employee_id, kind, due_on)
    SELECT d.id, d.kind, d.due_on FROM due d
    WHERE d.due_on IS NOT NULL AND d.due_on >= p_today
      AND d.due_on <= p_today + CASE WHEN d.kind = 'probation_end' THEN v_prob_days ELSE v_contract_days END
    ON CONFLICT DO NOTHING
    RETURNING employee_id, kind, due_on
  ), sent AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT hr.id, 'hr_reminder',
      CASE f.kind WHEN 'probation_end' THEN 'Probation ends soon' ELSE 'Contract ends soon' END,
      (SELECT full_name FROM public.profiles WHERE id = f.employee_id)
        || CASE f.kind WHEN 'probation_end' THEN ' completes the probation on ' ELSE '''s contract ends on ' END
        || to_char(f.due_on, 'FMMonth FMDD, YYYY') || '. Decide the next status before then.',
      'hr-employees'
    FROM fresh f
    CROSS JOIN public.profiles hr
    WHERE lower(hr.role::TEXT) = 'hr' AND NOT COALESCE(hr.archived, FALSE)
      AND COALESCE(hr.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM fresh;
  RETURN v_count;
END;
$$;

-- ── security: server only ───────────────────────────────────────────────────
ALTER TABLE public.employee_classification_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_credit_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_credit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_pay_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_hr_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statutory_leave_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_classification_changes, public.leave_credit_rules, public.leave_credit_overrides,
  public.employee_pay_rules, public.employee_hr_reminders, public.statutory_leave_types FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_classification_apply(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_probation_end(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_hr_reminders_run(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_classification_apply(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.employee_probation_end(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.employee_hr_reminders_run(DATE) TO service_role;

-- ── nightly jobs ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('employee-classification-apply', 'employee-hr-reminders');
    PERFORM cron.schedule('employee-classification-apply', '0 16 * * *', 'SELECT public.employee_classification_apply();');
    PERFORM cron.schedule('employee-hr-reminders', '40 16 * * *', 'SELECT public.employee_hr_reminders_run();');
  END IF;
END $$;
