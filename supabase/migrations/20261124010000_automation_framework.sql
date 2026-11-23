-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 3, Part E step 1 (2026-11-23): the shared automation framework.
-- Principle (user decision): the system prepares and applies; the Admin only
-- checks; HR approvals stay manual; no auto-approval anywhere except tenure.
-- Additive: one table, settings, presets, functions, one daily job.
--
--   automation_actions   every automatic action, "by System, rule: …", with the
--                        data it used. kind:
--                          applied   the system did it (HR may Undo with a reason)
--                          proposal  prepared for a decision: the branch Admin
--                                    checks it (Note / Object); with no objection
--                                    within automation.admin_check_days working
--                                    days (default 1) it goes to HR by itself
--                          flag      something to fix (closed when fixed)
--                        status: done | admin_check | with_hr | open |
--                                couldnt_decide | undone | closed
--   automation_daily()   forwards due Admin checks, escalates stale items
--                        (automation.stale_days working days, default 3, or past
--                        their effective date), sends the digest to Admin and HR.
--   automation.paused    HR / Super Admin "Pause automation". 'true' at release:
--                        nothing automatic runs until it is switched on.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.automation_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module          TEXT NOT NULL CHECK (module ~ '^[a-z_]{3,40}$'),
  rule            TEXT NOT NULL CHECK (char_length(btrim(rule)) BETWEEN 3 AND 300),
  kind            TEXT NOT NULL CHECK (kind IN ('applied', 'proposal', 'flag')),
  status          TEXT NOT NULL CHECK (status IN ('done', 'admin_check', 'with_hr', 'open', 'couldnt_decide', 'undone', 'closed')),
  summary         TEXT NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 3 AND 500),
  data            JSONB NOT NULL DEFAULT '{}'::JSONB,
  reason          TEXT,                    -- couldn't decide: why
  entity_type     TEXT,
  entity_id       TEXT,
  employee_id     UUID REFERENCES public.profiles(id),
  branch_id       UUID REFERENCES public.branches(id),
  effective_on    DATE,
  admin_due_on    DATE,
  admin_note      TEXT,
  admin_noted_by  UUID REFERENCES public.profiles(id),
  admin_noted_by_name TEXT,
  admin_noted_at  TIMESTAMPTZ,
  admin_objected  BOOLEAN NOT NULL DEFAULT FALSE,
  forwarded_at    TIMESTAMPTZ,
  forwarded_by    TEXT,                    -- 'System' or the Admin's name
  escalated_at    TIMESTAMPTZ,
  undone_at       TIMESTAMPTZ,
  undone_by       UUID REFERENCES public.profiles(id),
  undone_by_name  TEXT,
  undo_reason     TEXT,
  closed_at       TIMESTAMPTZ,
  closed_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_actions_status_idx ON public.automation_actions (status, branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_actions_entity_idx ON public.automation_actions (module, entity_type, entity_id);
ALTER TABLE public.automation_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_actions FROM anon, authenticated;

-- Part H: Undo (revoke) and Object remarks are audited with the change itself.
DROP TRIGGER IF EXISTS automation_actions_decision_remark ON public.automation_actions;
CREATE TRIGGER automation_actions_decision_remark AFTER INSERT OR UPDATE ON public.automation_actions
  FOR EACH ROW EXECUTE FUNCTION public.decision_remark_audit();

-- Settings, pending the school's policy manual.
INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', v.key, v.value, 'System'
FROM (VALUES ('paused', 'true'), ('admin_check_days', '1'), ('stale_days', '3')) v(key, value)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'automation' AND c.key = v.key);

-- Undo and Object presets for automatic actions (HR / Super Admin edit them in Settings).
INSERT INTO public.remark_presets (code, decision, entity_type, label, sort_order) VALUES
  ('revoke.automation.in_error', 'revoke', 'automation_action', 'Applied in error', 10),
  ('revoke.automation.wrong_data', 'revoke', 'automation_action', 'The data it used was wrong', 20),
  ('revoke.automation.rule_misfit', 'revoke', 'automation_action', 'The rule does not fit this case', 30),
  ('object.automation.wrong_data', 'object', 'automation_action', 'The data it used is wrong', 5)
ON CONFLICT (code) DO NOTHING;

/** automation.<key> as an integer (a default when unset or not a number). */
CREATE OR REPLACE FUNCTION public.automation_setting_int(p_key TEXT, p_default INTEGER)
 RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT CASE WHEN value ~ '^\d{1,3}$' THEN value::INTEGER END FROM public.system_config
                   WHERE section = 'automation' AND key = p_key LIMIT 1), p_default);
$function$;
REVOKE ALL ON FUNCTION public.automation_setting_int(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

/** "Pause automation" (HR / Super Admin): anything but 'false' is paused. */
CREATE OR REPLACE FUNCTION public.automation_paused()
 RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT value FROM public.system_config WHERE section = 'automation' AND key = 'paused' LIMIT 1), 'true') <> 'false';
$function$;
REVOKE ALL ON FUNCTION public.automation_paused() FROM PUBLIC, anon, authenticated;

/** A working day for a branch: Monday to Friday, not a whole-day holiday there. */
CREATE OR REPLACE FUNCTION public.automation_is_working_day(p_day DATE, p_branch UUID)
 RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXTRACT(ISODOW FROM p_day) BETWEEN 1 AND 5 AND NOT public.attendance_day_off_on(p_day, p_branch);
$function$;
REVOKE ALL ON FUNCTION public.automation_is_working_day(DATE, UUID) FROM PUBLIC, anon, authenticated;

/** The date p_n working days after p_from (for the branch's holidays). */
CREATE OR REPLACE FUNCTION public.automation_add_working_days(p_from DATE, p_n INTEGER, p_branch UUID)
 RETURNS DATE LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_day DATE := p_from;
  v_left INTEGER := GREATEST(0, p_n);
BEGIN
  WHILE v_left > 0 LOOP
    v_day := v_day + 1;
    IF public.automation_is_working_day(v_day, p_branch) THEN v_left := v_left - 1; END IF;
  END LOOP;
  RETURN v_day;
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_add_working_days(DATE, INTEGER, UUID) FROM PUBLIC, anon, authenticated;

/**
 * Log an automatic action (the modules call this). Returns its id, or NULL
 * while automation is paused (the module then does nothing either).
 */
CREATE OR REPLACE FUNCTION public.automation_log(
  p_module TEXT, p_rule TEXT, p_kind TEXT, p_summary TEXT, p_data JSONB DEFAULT '{}'::JSONB,
  p_employee UUID DEFAULT NULL, p_branch UUID DEFAULT NULL, p_entity_type TEXT DEFAULT NULL, p_entity_id TEXT DEFAULT NULL,
  p_effective_on DATE DEFAULT NULL, p_reason TEXT DEFAULT NULL)
 RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  v_id UUID;
  v_status TEXT;
BEGIN
  IF public.automation_paused() THEN RETURN NULL; END IF;
  v_status := CASE
    WHEN p_reason IS NOT NULL AND p_kind <> 'applied' THEN 'couldnt_decide'
    WHEN p_kind = 'applied' THEN 'done'
    WHEN p_kind = 'proposal' THEN 'admin_check'
    ELSE 'open' END;
  INSERT INTO public.automation_actions (module, rule, kind, status, summary, data, reason, entity_type, entity_id, employee_id, branch_id, effective_on, admin_due_on)
  VALUES (p_module, p_rule, p_kind, v_status, p_summary, COALESCE(p_data, '{}'::JSONB), p_reason, p_entity_type, p_entity_id, p_employee, p_branch, p_effective_on,
          CASE WHEN v_status = 'admin_check' THEN public.automation_add_working_days(v_today, public.automation_setting_int('admin_check_days', 1), p_branch) END)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata, is_system_event, actor_name, actor_role)
  VALUES (p_module, 'automation_' || p_kind, COALESCE(p_entity_type, 'automation_action'), COALESCE(p_entity_id, v_id::TEXT),
          format('by System, rule: %s. %s', p_rule, p_summary), 'success', 'system',
          jsonb_build_object('automation_action_id', v_id, 'rule', p_rule, 'data', COALESCE(p_data, '{}'::JSONB), 'reason', p_reason), TRUE, 'System', 'system');
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_log(TEXT, TEXT, TEXT, TEXT, JSONB, UUID, UUID, TEXT, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;

/** A module closes its item (the flag was fixed, HR decided the proposal). */
CREATE OR REPLACE FUNCTION public.automation_close(p_id UUID, p_note TEXT)
 RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  UPDATE public.automation_actions SET status = 'closed', closed_at = NOW(), closed_note = p_note, updated_at = NOW()
  WHERE id = p_id AND status IN ('admin_check', 'with_hr', 'open', 'couldnt_decide');
$function$;
REVOKE ALL ON FUNCTION public.automation_close(UUID, TEXT) FROM PUBLIC, anon, authenticated;

/**
 * The daily run: forward Admin checks with no objection, escalate stale items
 * (once), and send the digest. Nothing while paused.
 */
CREATE OR REPLACE FUNCTION public.automation_daily(p_today DATE DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::DATE))
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_forwarded INTEGER := 0;
  v_escalated INTEGER := 0;
  v_digests INTEGER := 0;
  v_stale INTEGER := public.automation_setting_int('stale_days', 3);
BEGIN
  IF public.automation_paused() THEN RETURN jsonb_build_object('paused', TRUE); END IF;

  -- 1. No objection within the Admin's check time: to HR, by the system.
  WITH f AS (
    UPDATE public.automation_actions
    SET status = 'with_hr', forwarded_at = NOW(), forwarded_by = 'System', updated_at = NOW()
    WHERE status = 'admin_check' AND admin_due_on <= p_today
    RETURNING id, module, summary
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT h.id, 'automation_forwarded', 'Prepared by the system, for your decision',
           format('%s (no objection from the branch Admin in time).', f.summary), 'hr-dashboard'
    FROM f JOIN public.profiles h ON h.role = 'hr' AND h.archived = FALSE
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_forwarded FROM f;

  -- 2. Stale: waiting more than the stale days (working days), or past its effective date. Once.
  WITH s AS (
    UPDATE public.automation_actions a
    SET escalated_at = NOW(), updated_at = NOW()
    WHERE a.status IN ('admin_check', 'with_hr', 'open', 'couldnt_decide') AND a.escalated_at IS NULL
      AND (public.automation_add_working_days((a.created_at AT TIME ZONE 'Asia/Manila')::DATE, v_stale, a.branch_id) <= p_today
           OR (a.effective_on IS NOT NULL AND a.effective_on < p_today))
    RETURNING a.id, a.summary, a.branch_id, a.effective_on
  ), told AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT r.id, 'automation_escalated', 'Waiting too long',
           format('%s%s', s.summary, CASE WHEN s.effective_on IS NOT NULL AND s.effective_on < p_today THEN format(' (effective %s has passed)', s.effective_on) ELSE '' END),
           CASE WHEN r.role = 'hr' THEN 'hr-dashboard' ELSE 'adm-dashboard' END
    FROM s JOIN public.profiles r ON r.archived = FALSE
      AND (r.role = 'hr' OR (r.role = 'admin' AND r.branch_id IS NOT DISTINCT FROM s.branch_id))
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_escalated FROM s;

  -- 3. The digest: done (since yesterday), waiting, couldn't decide. HR sees every branch; an Admin, their own.
  WITH counts AS (
    SELECT r.id AS recipient, r.role,
           COUNT(*) FILTER (WHERE a.status = 'done' AND a.created_at >= (p_today - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila') AS done,
           COUNT(*) FILTER (WHERE (r.role = 'admin' AND a.status = 'admin_check') OR (r.role = 'hr' AND a.status IN ('with_hr', 'open'))) AS waiting,
           COUNT(*) FILTER (WHERE a.status = 'couldnt_decide') AS undecided
    FROM public.profiles r
    JOIN public.automation_actions a ON (r.role = 'hr' OR a.branch_id IS NOT DISTINCT FROM r.branch_id)
    WHERE r.archived = FALSE AND r.role IN ('hr', 'admin')
    GROUP BY r.id, r.role
  ), sent AS (
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page)
    SELECT c.recipient, 'automation_digest', 'Automation: daily summary',
           format('%s done since yesterday · %s waiting for you · %s the system could not decide (see why on the Automation card).', c.done, c.waiting, c.undecided),
           CASE WHEN c.role = 'hr' THEN 'hr-dashboard' ELSE 'adm-dashboard' END
    FROM counts c WHERE c.done + c.waiting + c.undecided > 0
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_digests FROM sent;

  RETURN jsonb_build_object('forwarded', v_forwarded, 'escalated', v_escalated, 'digests', v_digests);
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_daily(DATE) FROM PUBLIC, anon, authenticated;

-- Daily at 00:50 Manila (16:50 UTC), after the nightly attendance close. It does nothing while paused.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('automation-daily', '50 16 * * *', 'SELECT public.automation_daily();');
  END IF;
END $$;

-- The backup lists the new table (from 20261123030000_awol_automation.sql, plus automation_actions).
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
    -- possible device / data problem days (Part D, 20261123030000)
    'attendance_data_gaps', 'automation_actions',
    -- leave
    'leave_requests',
    -- overtime requests (Part B, 20261122010000)
    'overtime_requests',
    -- substitute teaching (Part C, 20261123020000)
    'substitutions',
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
