-- ═══════════════════════════════════════════════════════════════════════════
-- Employee classification (user decisions 2026-11-23). Additive.
--  1. Employment status "Provisional" (dated history and reminders like
--     Probationary): allowed on profiles, dated changes, leave credit rules
--     and pay rules; default rules added for it.
--  2. Maintenance is a group within Non-Teaching (profiles.staff_group), not a
--     category: selectable, filterable, shown in lists and reports.
--  3. Leave credit defaults (settings, HR still edits them): Regular 5 vacation
--     / 5 sick; Probationary, Provisional, Contractual 3 / 3. Someone with 1+
--     year of service earns the Regular credits from that date (app,
--     hr.regular_credits_after_months = 12). Emergency leave unchanged. Only
--     the untouched defaults ("Default: pending policy manual") are changed.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Provisional --------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_employment_status_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_employment_status_valid
  CHECK (employment_status IS NULL OR employment_status IN ('Regular', 'Probationary', 'Provisional', 'Contractual'));

ALTER TABLE public.employee_classification_changes DROP CONSTRAINT IF EXISTS employee_classification_changes_value_chk;
ALTER TABLE public.employee_classification_changes ADD CONSTRAINT employee_classification_changes_value_chk CHECK (
  (field = 'employee_type' AND new_value IN ('Teaching', 'Non-Teaching'))
  OR (field = 'employment_status' AND new_value IN ('Regular', 'Probationary', 'Provisional', 'Contractual'))
  OR (field = 'employment_type' AND new_value IN ('Full-time', 'Part-time'))
  OR (field = 'on_payroll' AND new_value IN ('true', 'false'))
  OR (field = 'contract_end_date' AND (new_value IS NULL OR new_value ~ '^\d{4}-\d{2}-\d{2}$')));

DO $$
DECLARE r RECORD;
BEGIN
  -- The column checks on employment_status (auto-named) of the two rule tables.
  FOR r IN SELECT c.conrelid::regclass AS tbl, c.conname FROM pg_constraint c
           WHERE c.contype = 'c' AND c.conrelid IN ('public.leave_credit_rules'::regclass, 'public.employee_pay_rules'::regclass)
             AND pg_get_constraintdef(c.oid) LIKE '%employment_status%' AND pg_get_constraintdef(c.oid) LIKE '%Probationary%' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
ALTER TABLE public.leave_credit_rules ADD CONSTRAINT leave_credit_rules_employment_status_check
  CHECK (employment_status IN ('Regular', 'Probationary', 'Provisional', 'Contractual'));
ALTER TABLE public.employee_pay_rules ADD CONSTRAINT employee_pay_rules_employment_status_check
  CHECK (employment_status IN ('Regular', 'Probationary', 'Provisional', 'Contractual'));

INSERT INTO public.leave_credit_rules (leave_type, employee_type, employment_status, employment_type, days_per_year, effective_from, note, created_by_name)
SELECT lt.leave_type, et.v, 'Provisional', 'Full-time', lt.days, DATE '2026-01-01', 'Default: pending policy manual', 'System'
FROM (VALUES ('Vacation Leave', 3), ('Sick Leave', 3),
             ('Emergency Leave', COALESCE((SELECT days_per_year FROM public.leave_credit_rules WHERE leave_type = 'Emergency Leave'
               AND employment_status = 'Probationary' AND employment_type = 'Full-time' ORDER BY effective_from DESC LIMIT 1), 3))) lt(leave_type, days)
CROSS JOIN (VALUES ('Teaching'), ('Non-Teaching')) et(v)
ON CONFLICT DO NOTHING;

INSERT INTO public.employee_pay_rules (employee_type, employment_status, employment_type, pay_basis, effective_from, note, created_by_name)
SELECT et.v, 'Provisional', 'Full-time', 'monthly', DATE '2026-01-01', 'Default: pending policy manual', 'System'
FROM (VALUES ('Teaching'), ('Non-Teaching')) et(v)
ON CONFLICT DO NOTHING;

-- Probation reminders cover Provisional too.
CREATE OR REPLACE FUNCTION public.employee_probation_end(p_employee UUID)
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (COALESCE(
      (SELECT MAX(c.effective_on) FROM public.employee_classification_changes c
       WHERE c.employee_id = p.id AND c.field = 'employment_status' AND c.new_value IN ('Probationary', 'Provisional') AND c.cancelled_at IS NULL),
      p.date_hired, p.created_at::DATE)
    + make_interval(months => COALESCE((SELECT NULLIF(value, '')::INTEGER FROM public.system_config WHERE section = 'hr' AND key = 'probation_months'), 6)))::DATE
  FROM public.profiles p
  WHERE p.id = p_employee AND p.employment_status IN ('Probationary', 'Provisional');
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
    SELECT p.id, p.full_name, 'probation_end'::TEXT AS kind, public.employee_probation_end(p.id) AS due_on, p.employment_status
    FROM public.profiles p
    WHERE p.employment_status IN ('Probationary', 'Provisional') AND NOT COALESCE(p.archived, FALSE) AND p.on_payroll
    UNION ALL
    SELECT p.id, p.full_name, 'contract_end', p.contract_end_date, p.employment_status
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
      CASE f.kind WHEN 'probation_end' THEN
        CASE WHEN p.employment_status = 'Provisional' THEN 'Provisional period ends soon' ELSE 'Probation ends soon' END
        ELSE 'Contract ends soon' END,
      p.full_name
        || CASE f.kind WHEN 'probation_end' THEN
             CASE WHEN p.employment_status = 'Provisional' THEN ' completes the provisional period on ' ELSE ' completes the probation on ' END
           ELSE '''s contract ends on ' END
        || to_char(f.due_on, 'FMMonth FMDD, YYYY') || '. Decide the next status before then.',
      'hr-employees'
    FROM fresh f
    JOIN public.profiles p ON p.id = f.employee_id
    CROSS JOIN public.profiles hr
    WHERE lower(hr.role::TEXT) = 'hr' AND NOT COALESCE(hr.archived, FALSE)
      AND COALESCE(hr.employee_status, 'Active') NOT IN ('Inactive', 'Archived', 'Separated')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM fresh;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.employee_probation_end(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_hr_reminders_run(DATE) FROM PUBLIC, anon, authenticated;

-- 2. Maintenance group within Non-Teaching ----------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS staff_group TEXT;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_staff_group_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_staff_group_valid CHECK (staff_group IS NULL OR staff_group IN ('Maintenance'));

-- 3. Leave credit defaults: new employees 3 vacation / 3 sick (untouched defaults only) ------
UPDATE public.leave_credit_rules SET days_per_year = 3
WHERE note = 'Default: pending policy manual' AND created_by_name = 'System'
  AND leave_type IN ('Vacation Leave', 'Sick Leave') AND employment_status IN ('Probationary', 'Contractual');
UPDATE public.leave_credit_rules SET days_per_year = 5
WHERE note = 'Default: pending policy manual' AND created_by_name = 'System'
  AND leave_type IN ('Vacation Leave', 'Sick Leave') AND employment_status = 'Regular';

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'hr', 'regular_credits_after_months', '12', 'System'
WHERE NOT EXISTS (SELECT 1 FROM public.system_config WHERE section = 'hr' AND key = 'regular_credits_after_months');
