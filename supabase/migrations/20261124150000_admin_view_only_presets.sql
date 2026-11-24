-- ═══════════════════════════════════════════════════════════════════════════
-- Admin = view and monitor (2026-11-24 release):
--  1. A system proposal goes STRAIGHT to HR (no "waiting for the Admin's check").
--     Items still waiting for the Admin move to HR now.
--  2. Preset remarks for what the Admin still files (decision "file"):
--     incidents, discretionary incentive proposals, RFID issues. HR edits them
--     in Settings > Preset Remarks; "Other (write your own)" is built in.
--  3. Substitutions: the system proposes one when a teacher's leave is
--     approved (no substitute yet; HR picks one and approves); HR files one by
--     hand only for an unplanned absence. An approved one always names the
--     substitute.
-- Additive: no row is deleted; existing Admin items stay readable for HR.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Straight to HR.
CREATE OR REPLACE FUNCTION public.automation_log(p_module text, p_rule text, p_kind text, p_summary text, p_data jsonb DEFAULT '{}'::jsonb, p_employee uuid DEFAULT NULL::uuid, p_branch uuid DEFAULT NULL::uuid, p_entity_type text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_effective_on date DEFAULT NULL::date, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  v_id UUID;
  v_status TEXT;
BEGIN
  IF public.automation_off(p_module) THEN RETURN NULL; END IF;
  -- A dry run counts the action and writes nothing.
  IF public.automation_dry_run() THEN RETURN gen_random_uuid(); END IF;
  v_status := CASE
    WHEN p_reason IS NOT NULL AND p_kind <> 'applied' THEN 'couldnt_decide'
    WHEN p_kind = 'applied' THEN 'done'
    -- 2026-11-24: no Admin step; a proposal goes straight to HR.
    WHEN p_kind = 'proposal' THEN 'with_hr'
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

UPDATE public.automation_actions
   SET status = 'with_hr', forwarded_at = COALESCE(forwarded_at, NOW()), forwarded_by = COALESCE(forwarded_by, 'System (no Admin step)'), admin_due_on = NULL, updated_at = NOW()
 WHERE status = 'admin_check';

-- 2. Preset remarks for the Admin's filings.
ALTER TABLE public.remark_presets DROP CONSTRAINT IF EXISTS remark_presets_decision_check;
ALTER TABLE public.remark_presets ADD CONSTRAINT remark_presets_decision_check
  CHECK (decision = ANY (ARRAY['approve', 'reject', 'resolve', 'endorse', 'object', 'override', 'revoke', 'file']));

INSERT INTO public.remark_presets (code, decision, entity_type, label, active, sort_order, updated_by)
VALUES
  ('file.incident.repeated_tardiness', 'file', 'incident_report', 'Repeated tardiness', TRUE, 10, 'System'),
  ('file.incident.no_show', 'file', 'incident_report', 'No-show without notice', TRUE, 20, 'System'),
  ('file.incident.no_time_out', 'file', 'incident_report', 'Left without time out', TRUE, 30, 'System'),
  ('file.incident.misconduct', 'file', 'incident_report', 'Misconduct reported', TRUE, 40, 'System'),
  ('file.incentive.extra_class', 'file', 'incentive_endorsement', 'Extra class/coaching', TRUE, 10, 'System'),
  ('file.incentive.event_hosting', 'file', 'incentive_endorsement', 'Event hosting', TRUE, 20, 'System'),
  ('file.incentive.overload', 'file', 'incentive_endorsement', 'Overload', TRUE, 30, 'System'),
  ('file.rfid.card_lost', 'file', 'rfid_issue', 'Card lost', TRUE, 10, 'System'),
  ('file.rfid.card_damaged', 'file', 'rfid_issue', 'Card damaged', TRUE, 20, 'System'),
  ('file.rfid.reader_down', 'file', 'rfid_issue', 'Reader not working', TRUE, 30, 'System'),
  ('file.rfid.card_not_registered', 'file', 'rfid_issue', 'Card not registered', TRUE, 40, 'System')
ON CONFLICT (code) DO NOTHING;

-- 3. Substitution proposals.
ALTER TABLE public.substitutions ALTER COLUMN substitute_id DROP NOT NULL;
ALTER TABLE public.substitutions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE public.substitutions DROP CONSTRAINT IF EXISTS substitutions_source_check;
ALTER TABLE public.substitutions ADD CONSTRAINT substitutions_source_check CHECK (source IN ('manual', 'leave', 'unplanned'));
ALTER TABLE public.substitutions DROP CONSTRAINT IF EXISTS substitutions_approved_has_substitute;
ALTER TABLE public.substitutions ADD CONSTRAINT substitutions_approved_has_substitute CHECK (status <> 'approved' OR substitute_id IS NOT NULL);
-- One proposal per leave and day (re-approving never duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS substitutions_one_per_leave_day ON public.substitutions (leave_request_id, sub_date)
  WHERE source = 'leave' AND status IN ('pending', 'approved');
