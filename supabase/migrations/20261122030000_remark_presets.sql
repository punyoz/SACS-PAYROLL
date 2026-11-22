-- ═══════════════════════════════════════════════════════════════════════════
-- Part H (2026-11-22): preset remarks for HR / Admin / Super Admin decisions.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every remark on an approve / reject / resolve / endorse / object / override
-- / revoke picks a preset (or "Other", written by hand). The decision's own
-- record keeps the text as before; the preset's code and the text are written
-- to audit_logs IN THE SAME TRANSACTION as the decision:
--
--   the API sends the remark in the request header x-sacs-remark (base64
--   JSON: code, text, decision, entity_type, module, table, ids, ops, actor); the
--   trigger decision_remark_audit() on the decided table reads it
--   (request.headers, set by PostgREST for the request's transaction) and
--   inserts one audit entry per decided row. A bad or deactivated preset, or
--   a failed insert, raises: the decision fails too. A bulk decision writes
--   one entry per item.
--
-- Reports count reasons from audit_logs (metadata.kind = 'decision_remark').
-- A deactivated preset stays readable: old records and audit entries keep
-- their text. Additive: the current production code never sends the header.

CREATE TABLE IF NOT EXISTS public.remark_presets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_.-]{3,80}$'),
  decision    TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'resolve', 'endorse', 'object', 'override', 'revoke')),
  entity_type TEXT NOT NULL DEFAULT '*' CHECK (entity_type ~ '^([a-z_]{3,40}|\*)$'),
  label       TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 3 AND 120),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS remark_presets_decision_idx ON public.remark_presets (decision, entity_type, sort_order);
ALTER TABLE public.remark_presets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.remark_presets FROM anon, authenticated;

-- Defaults, pending the school's policy manual (HR / Super Admin edit them in Settings).
INSERT INTO public.remark_presets (code, decision, entity_type, label, sort_order) VALUES
  ('approve.as_requested', 'approve', '*', 'Approved as requested', 10),
  ('approve.with_adjustment', 'approve', '*', 'Approved with adjustment', 20),
  ('reject.leave.insufficient_credits', 'reject', 'leave_request', 'Insufficient leave credits', 10),
  ('reject.leave.filed_late', 'reject', 'leave_request', 'Filed late', 20),
  ('reject.leave.school_activity', 'reject', 'leave_request', 'Conflicts with school activity', 30),
  ('reject.leave.incomplete_documents', 'reject', 'leave_request', 'Incomplete documents', 40),
  ('reject.overtime.not_needed', 'reject', 'overtime_request', 'Not needed for the task', 10),
  ('reject.overtime.over_limit', 'reject', 'overtime_request', 'Over the overtime limit', 20),
  ('reject.payroll.figures', 'reject', 'payroll_run', 'Figures need checking', 10),
  ('reject.payroll.attendance', 'reject', 'payroll_run', 'Attendance not yet resolved', 20),
  ('reject.incomplete', 'reject', '*', 'Incomplete information', 80),
  ('reject.policy', 'reject', '*', 'Not allowed by policy', 90),
  ('reject.duplicate', 'reject', '*', 'Duplicate request', 95),
  ('resolve.record_corrected', 'resolve', '*', 'Record corrected', 10),
  ('resolve.employee_filed', 'resolve', '*', 'Employee filed time correction', 20),
  ('resolve.no_correction', 'resolve', '*', 'No correction needed', 30),
  ('resolve.duplicate_report', 'resolve', '*', 'Duplicate report', 40),
  ('endorse.recommend', 'endorse', '*', 'Recommend approval', 10),
  ('endorse.coverage', 'endorse', '*', 'Coverage arranged', 20),
  ('object.staffing', 'object', '*', 'Branch staffing too low', 10),
  ('object.review', 'object', '*', 'Needs further review', 20),
  ('override.entry_error', 'override', '*', 'Data entry error corrected', 10),
  ('override.exception', 'override', '*', 'Approved exception', 20),
  ('revoke.not_eligible', 'revoke', '*', 'No longer eligible', 10),
  ('revoke.in_error', 'revoke', '*', 'Granted in error', 20)
ON CONFLICT (code) DO NOTHING;

-- Reports read reasons by decision, type, branch and date.
CREATE INDEX IF NOT EXISTS audit_logs_decision_remark_idx ON public.audit_logs (created_at)
  WHERE (metadata ->> 'kind') = 'decision_remark';

CREATE OR REPLACE FUNCTION public.decision_remark_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_header TEXT := current_setting('request.headers', true)::JSON ->> 'x-sacs-remark';
  v_remark JSONB;
  v_row JSONB := to_jsonb(NEW);
  v_id TEXT := v_row ->> 'id';
  v_preset public.remark_presets;
  v_code TEXT;
  v_text TEXT;
  v_branch UUID;
BEGIN
  IF v_header IS NULL OR v_header = '' THEN RETURN NULL; END IF;
  BEGIN
    v_remark := convert_from(decode(v_header, 'base64'), 'UTF8')::JSONB;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'The remark could not be read.' USING ERRCODE = '22023';
  END;
  -- Only the table and rows this decision is about (other tables the same
  -- request writes keep no remark).
  IF v_remark ->> 'table' IS DISTINCT FROM TG_TABLE_NAME THEN RETURN NULL; END IF;
  IF jsonb_typeof(v_remark -> 'ids') = 'array' AND NOT ((v_remark -> 'ids') ? v_id) THEN RETURN NULL; END IF;
  -- ops: only the decision's own write (e.g. ["INSERT"]: the new correction row, not a request it settles).
  IF jsonb_typeof(v_remark -> 'ops') = 'array' AND NOT ((v_remark -> 'ops') ? TG_OP) THEN RETURN NULL; END IF;
  -- One entry per decided row and decision: a function that inserts then
  -- updates the same row in this transaction is counted once (now() is the
  -- transaction's start, the same for both).
  IF EXISTS (SELECT 1 FROM public.audit_logs a
             WHERE a.created_at = now() AND a.entity_id = v_id AND (a.metadata ->> 'kind') = 'decision_remark'
               AND (a.metadata ->> 'table') = TG_TABLE_NAME) THEN
    RETURN NULL;
  END IF;

  v_code := v_remark ->> 'code';
  v_text := btrim(COALESCE(v_remark ->> 'text', ''));
  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Choose a remark.' USING ERRCODE = '22023';
  END IF;
  IF v_code = 'other' THEN
    IF char_length(v_text) < 3 THEN RAISE EXCEPTION 'Write the remark (at least 3 characters).' USING ERRCODE = '22023'; END IF;
  ELSE
    SELECT * INTO v_preset FROM public.remark_presets WHERE code = v_code;
    IF NOT FOUND OR NOT v_preset.active THEN
      RAISE EXCEPTION 'That remark is no longer offered. Choose another.' USING ERRCODE = '22023';
    END IF;
    IF v_preset.decision <> v_remark ->> 'decision'
       OR (v_preset.entity_type <> '*' AND v_preset.entity_type <> v_remark ->> 'entity_type') THEN
      RAISE EXCEPTION 'That remark is not for this decision.' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_text) = 0 THEN v_text := v_preset.label; END IF;
  END IF;

  BEGIN
    v_branch := NULLIF(v_row ->> 'branch_id', '')::UUID;
  EXCEPTION WHEN OTHERS THEN v_branch := NULL;
  END;

  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata,
                                 branch_id, is_system_event, actor_id, actor_role, actor_name)
  VALUES (COALESCE(NULLIF(v_remark ->> 'module', ''), 'decisions'), v_remark ->> 'decision', v_remark ->> 'entity_type', v_id,
          format('Remark (%s): %s', v_remark ->> 'decision', v_text), 'success', 'api',
          jsonb_build_object('kind', 'decision_remark', 'remark_code', v_code, 'remark_text', v_text,
                             'preset_label', v_preset.label, 'table', TG_TABLE_NAME),
          v_branch, FALSE,
          CASE WHEN v_remark ->> 'actor_id' ~ '^[0-9a-f-]{36}$' THEN (v_remark ->> 'actor_id')::UUID END,
          NULLIF(v_remark ->> 'actor_role', ''), NULLIF(v_remark ->> 'actor_name', ''));
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.decision_remark_audit() FROM PUBLIC, anon, authenticated;

-- The decided tables (each decision route names its table in the header).
DROP TRIGGER IF EXISTS leave_requests_decision_remark ON public.leave_requests;
CREATE TRIGGER leave_requests_decision_remark AFTER INSERT OR UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS branch_admin_requests_decision_remark ON public.branch_admin_requests;
CREATE TRIGGER branch_admin_requests_decision_remark AFTER INSERT OR UPDATE ON public.branch_admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS overtime_requests_decision_remark ON public.overtime_requests;
CREATE TRIGGER overtime_requests_decision_remark AFTER INSERT OR UPDATE ON public.overtime_requests
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS attendance_corrections_decision_remark ON public.attendance_corrections;
CREATE TRIGGER attendance_corrections_decision_remark AFTER INSERT OR UPDATE ON public.attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS payroll_runs_decision_remark ON public.payroll_runs;
CREATE TRIGGER payroll_runs_decision_remark AFTER INSERT OR UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS employee_awol_cases_decision_remark ON public.employee_awol_cases;
CREATE TRIGGER employee_awol_cases_decision_remark AFTER INSERT OR UPDATE ON public.employee_awol_cases
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS payroll_final_pay_submissions_decision_remark ON public.payroll_final_pay_submissions;
CREATE TRIGGER payroll_final_pay_submissions_decision_remark AFTER INSERT OR UPDATE ON public.payroll_final_pay_submissions
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS payroll_loans_decision_remark ON public.payroll_loans;
CREATE TRIGGER payroll_loans_decision_remark AFTER INSERT OR UPDATE ON public.payroll_loans
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS payroll_monthly_incentives_decision_remark ON public.payroll_monthly_incentives;
CREATE TRIGGER payroll_monthly_incentives_decision_remark AFTER INSERT OR UPDATE ON public.payroll_monthly_incentives
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS tenure_protection_grants_decision_remark ON public.tenure_protection_grants;
CREATE TRIGGER tenure_protection_grants_decision_remark AFTER INSERT OR UPDATE ON public.tenure_protection_grants
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS payroll_subsidy_requests_decision_remark ON public.payroll_subsidy_requests;
CREATE TRIGGER payroll_subsidy_requests_decision_remark AFTER INSERT OR UPDATE ON public.payroll_subsidy_requests
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS payroll_corrections_decision_remark ON public.payroll_corrections;
CREATE TRIGGER payroll_corrections_decision_remark AFTER INSERT OR UPDATE ON public.payroll_corrections
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();
DROP TRIGGER IF EXISTS transfer_requests_decision_remark ON public.transfer_requests;
CREATE TRIGGER transfer_requests_decision_remark AFTER INSERT OR UPDATE ON public.transfer_requests
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();

CREATE OR REPLACE FUNCTION public.backup_export_tables()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    -- users, employees, branches, roles
    'profiles', 'branches', 'role_permissions', 'employee_branch_assignments', 'branch_admin_requests',
    'employee_salary_changes', 'employee_status_changes', 'employee_awol_cases',
    'employee_license_changes', 'employee_license_alerts', 'employee_license_documents',
    'tenure_protection_policies', 'tenure_protection_grants', 'tenure_protection_applications',
    'rfid_cards', 'rfid_card_events', 'rfid_terminals', 'transfer_requests',
    -- the positions list (20261109050000), added to the backup 2026-11-15
    'employee_positions',
    -- Part A (20261121010000): classification history, HR reminders, leave and pay rules
    'employee_classification_changes', 'employee_hr_reminders', 'leave_credit_rules', 'leave_credit_overrides',
    'statutory_leave_types', 'employee_pay_rules',
    'work_schedules', 'work_schedule_assignments',
    -- attendance
    'attendance_logs', 'attendance_logs_history', 'attendance_corrections', 'attendance_overtime_approvals',
    'attendance_blocked_taps', 'attendance_taps', 'attendance_holidays', 'school_break_periods',
    'holiday_duty_assignments', 'holiday_duty_history', 'holiday_work_reviews', 'early_bird_winners',
    -- leave
    'leave_requests',
    -- overtime requests (Part B, 20261122010000)
    'overtime_requests',
    -- payroll
    'payroll_entries', 'payroll_records', 'payroll_runs', 'payroll_run_items', 'payroll_run_exclusions',
    'payroll_approval_history', 'payroll_corrections', 'payroll_final_overrides', 'payroll_review_flags',
    'payroll_tax_annualizations', 'payroll_bir_exports',
    -- final pay waiting for HR (20261120010000), added to the backup 2026-11-21
    'payroll_final_pay_submissions',
    -- loans, advances, incentives, subsidy, 13th month
    'payroll_loans', 'payroll_loan_payments', 'payroll_cash_advances', 'payroll_incentives',
    'payroll_monthly_incentives', 'payroll_deductions', 'payroll_contribution_amounts',
    'payroll_subsidy_requests', 'payroll_subsidy_adjustments', 'payroll_subsidy_balances',
    'payroll_subsidy_settings', 'payroll_thirteenth_month',
    -- preset remarks for decisions (Part H, 20261122030000)
    'remark_presets',
    -- rates and settings
    'payroll_rate_configs', 'payroll_tax_brackets', 'payroll_sss_msc_brackets', 'payroll_schedule_settings',
    'payroll_setting_changes', 'payroll_window_enforcement', 'payroll_window_enforcement_changes', 'system_config',
    -- announcements, audit
    'branch_announcements', 'audit_logs'
  ]::text[];
$function$;
