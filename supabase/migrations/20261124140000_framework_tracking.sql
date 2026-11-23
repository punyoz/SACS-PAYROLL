-- ═══════════════════════════════════════════════════════════════════════════
-- Part E (2026-11-23): overtime requests, substitutions and AWOL cases join
-- the automation framework. Each one waiting for HR is an open item (module
-- overtime_requests / substitutions / awol_cases) so the stale-item
-- escalation, the daily digest and the Automation card count it; it closes by
-- itself when HR decides (or the case closes). Nothing is decided here.
-- Triggers, so every path that files or decides them is covered. Paused with
-- the module or everything (automation_log returns NULL then). Additive.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.system_config (section, key, value, updated_by)
SELECT 'automation', v.key, 'false', 'System'
FROM (VALUES ('paused_overtime_requests'), ('paused_substitutions'), ('paused_awol_cases')) v(key)
WHERE NOT EXISTS (SELECT 1 FROM public.system_config c WHERE c.section = 'automation' AND c.key = v.key);

CREATE OR REPLACE FUNCTION public.automation_track_waiting()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_module TEXT := TG_ARGV[0];
  v_entity TEXT := TG_ARGV[1];
  v_waiting_new BOOLEAN;
  v_waiting_old BOOLEAN := FALSE;
  v_name TEXT;
  v_summary TEXT;
  v_employee UUID;
  v_on DATE;
BEGIN
  -- One branch per table: each names only its own columns (a record field missing in NEW fails at run time).
  IF v_entity = 'awol_case' THEN
    v_waiting_new := NEW.stage <> 'closed';
    IF TG_OP = 'UPDATE' THEN v_waiting_old := OLD.stage <> 'closed'; END IF;
    v_employee := NEW.employee_id;
    v_on := NULL;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = v_employee;
    v_summary := format('AWOL case, %s: absent from %s. HR follows it up.', COALESCE(v_name, 'employee'), to_char(NEW.first_absent_on, 'Mon DD'));
  ELSIF v_entity = 'substitution' THEN
    v_waiting_new := NEW.status = 'pending';
    IF TG_OP = 'UPDATE' THEN v_waiting_old := OLD.status = 'pending'; END IF;
    v_employee := NEW.substitute_id;
    v_on := NEW.sub_date;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = v_employee;
    v_summary := format('Substitution, %s covering on %s. Waits for HR.', COALESCE(v_name, 'employee'), to_char(NEW.sub_date, 'Mon DD'));
  ELSE
    v_waiting_new := NEW.status = 'pending';
    IF TG_OP = 'UPDATE' THEN v_waiting_old := OLD.status = 'pending'; END IF;
    v_employee := NEW.employee_id;
    v_on := NEW.request_date;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = v_employee;
    v_summary := format('Overtime request, %s: %s, %s min. Waits for HR.', COALESCE(v_name, 'employee'), to_char(NEW.request_date, 'Mon DD'), NEW.minutes);
  END IF;

  IF v_waiting_new AND NOT v_waiting_old THEN
    PERFORM public.automation_log(v_module, CASE v_entity WHEN 'awol_case' THEN 'an open AWOL case is tracked until it closes' ELSE 'a request waits for HR' END,
      'flag', v_summary, jsonb_build_object('code', v_entity), v_employee, NEW.branch_id, v_entity, NEW.id::TEXT, v_on);
  ELSIF v_waiting_old AND NOT v_waiting_new THEN
    PERFORM public.automation_close(a.id, CASE WHEN v_entity = 'awol_case' THEN 'The case closed' ELSE 'Decided by HR' END)
    FROM public.automation_actions a
    WHERE a.module = v_module AND a.entity_type = v_entity AND a.entity_id = NEW.id::TEXT AND a.status <> 'closed';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.automation_track_waiting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS overtime_requests_track ON public.overtime_requests;
CREATE TRIGGER overtime_requests_track AFTER INSERT OR UPDATE OF status ON public.overtime_requests
  FOR EACH ROW EXECUTE FUNCTION public.automation_track_waiting('overtime_requests', 'overtime_request');
DROP TRIGGER IF EXISTS substitutions_track ON public.substitutions;
CREATE TRIGGER substitutions_track AFTER INSERT OR UPDATE OF status ON public.substitutions
  FOR EACH ROW EXECUTE FUNCTION public.automation_track_waiting('substitutions', 'substitution');
DROP TRIGGER IF EXISTS employee_awol_cases_track ON public.employee_awol_cases;
CREATE TRIGGER employee_awol_cases_track AFTER INSERT OR UPDATE OF stage ON public.employee_awol_cases
  FOR EACH ROW EXECUTE FUNCTION public.automation_track_waiting('awol_cases', 'awol_case');
