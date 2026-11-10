-- ════════════════════════════════════════════════════════════════════════════
-- Two RFID terminals of one branch read the same card at the same moment
-- (G9.6, 2026-11-09): the server's "already tapped?" check ran in both
-- requests before either had saved, so TWO raw taps were stored. Decision
-- 2026-11-09 #2: a duplicate goes to the audit log, never the raw tap table.
--
-- The database now serialises taps per person (a transaction lock on the
-- employee) and skips a tap that lands inside the duplicate window (Super
-- Admin setting attendance.duplicate_tap_seconds, 3-10 s, default 5) of one
-- already stored; the skipped tap is written to the audit log instead. The
-- 5-minute repeat rule and everything else in the tap route are unchanged.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.attendance_taps_duplicate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window integer;
  v_raw text;
  v_previous timestamptz;
BEGIN
  IF NEW.employee_id IS NULL OR NEW.tapped_at IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance_tap:' || NEW.employee_id::text, 0));
  SELECT value::text INTO v_raw FROM public.system_config WHERE section = 'attendance' AND key = 'duplicate_tap_seconds';
  v_raw := btrim(COALESCE(v_raw, ''), '"');
  v_window := CASE WHEN v_raw ~ '^\d+$' AND v_raw::integer BETWEEN 3 AND 10 THEN v_raw::integer ELSE 5 END;
  SELECT t.tapped_at INTO v_previous FROM public.attendance_taps t
  WHERE t.employee_id = NEW.employee_id
    AND t.tapped_at BETWEEN NEW.tapped_at - make_interval(secs => v_window) AND NEW.tapped_at + make_interval(secs => v_window)
  ORDER BY t.tapped_at DESC LIMIT 1;
  IF v_previous IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, branch_id, is_system_event, metadata)
  VALUES ('attendance', 'rfid_duplicate_tap', 'employee', NEW.employee_id::text,
    format('Duplicate RFID tap for %s %s s after the one stored at the same moment (window %s s, two terminals); not counted.',
      COALESCE(NEW.employee_name, 'an employee'), round(abs(extract(epoch FROM NEW.tapped_at - v_previous))::numeric, 1), v_window),
    'success', 'database', NEW.branch_id, false,
    jsonb_build_object('employee_id', NEW.employee_id, 'duplicate', true, 'duplicate_window_seconds', v_window, 'tapped_at', NEW.tapped_at, 'stored', v_previous, 'device', NEW.device));
  RETURN NULL; -- not stored: the duplicate lives in the audit log only
END;
$$;

DROP TRIGGER IF EXISTS attendance_taps_00_duplicate_guard ON public.attendance_taps;
CREATE TRIGGER attendance_taps_00_duplicate_guard BEFORE INSERT ON public.attendance_taps
  FOR EACH ROW EXECUTE FUNCTION public.attendance_taps_duplicate_guard();
