-- ═══════════════════════════════════════════════════════════════════════════
-- Attendance history: attribute database-function edits to their reviewer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260927020000_attendance_logs_history.sql records every attendance change,
-- but edits made inside the database functions (correction review, resolving
-- an Incomplete day, correcting an absence, the day close) arrived with no
-- annotation and read as change_source = 'database', changed_by = NULL. The
-- reviewer was only on attendance_corrections.
--
-- Each of those functions now states, at its start, who is acting and why,
-- in transaction-local settings (set_config(..., true): gone when the
-- transaction ends, so they cannot leak into another request):
--
--   app.actor_id       the reviewer / requesting employee (empty for the close)
--   app.change_source  correction_review | incomplete_resolution |
--                      absence_correction | correction_request | day_close
--
-- attendance_logs_change_actor() uses them whenever the UPDATE itself did not
-- carry a fresh change_token (the API's own annotation still wins).
--
-- The functions' bodies are otherwise unchanged: each is re-created from its
-- live definition with only those two lines added after its BEGIN.
--
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.attendance_logs_change_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor TEXT := NULLIF(current_setting('app.actor_id', true), '');
BEGIN
  IF NEW.change_token IS NOT DISTINCT FROM OLD.change_token THEN
    NEW.changed_by := CASE
      WHEN v_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_actor::UUID
      ELSE NULL
    END;
    NEW.change_source := COALESCE(NULLIF(current_setting('app.change_source', true), ''), 'database');
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  item RECORD;
  def TEXT;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('attendance_review_correction',  'correction_review',     'p_reviewer::TEXT'),
      ('attendance_resolve_record',     'incomplete_resolution', 'p_reviewer::TEXT'),
      ('attendance_correct_absence',    'absence_correction',    'p_reviewer::TEXT'),
      ('attendance_request_correction', 'correction_request',    'p_employee_id::TEXT'),
      ('attendance_close_days',         'day_close',             '''''')
    ) AS v(fn_name, source, actor_expr)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = item.fn_name;

    IF def IS NULL THEN
      RAISE NOTICE 'skipping %: not found', item.fn_name;
      CONTINUE;
    END IF;
    IF position('app.change_source' IN def) > 0 THEN
      CONTINUE; -- already annotated
    END IF;

    def := regexp_replace(
      def,
      '\mBEGIN\M',
      format(E'BEGIN\n  PERFORM set_config(''app.change_source'', %L, true);\n  PERFORM set_config(''app.actor_id'', COALESCE(%s, ''''), true);',
             item.source, item.actor_expr)
    );
    EXECUTE def;
  END LOOP;
END;
$$;
