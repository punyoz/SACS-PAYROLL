-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261122030000_remark_presets.sql (Part H)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY. One transaction, rolled back. The request header the
-- API sends (x-sacs-remark) is set the way PostgREST sets it
-- (request.headers, local to the transaction).
--
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/remark-presets-scenarios.sql
--
-- Ends with NOTICE "all remark preset scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id) VALUES
  ('00000000-0000-4000-8000-0000000005a1', 'rem@remark.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES ('00000000-0000-4000-8000-0000000005f1', 'Remark Branch') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived) VALUES
  ('00000000-0000-4000-8000-0000000005a1', 'rem@remark.test', 'Rem Remark', 'employee', '00000000-0000-4000-8000-0000000005f1', FALSE)
ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id;

INSERT INTO public.leave_requests (id, employee_id, employee_name, leave_type, start_date, end_date, status, branch_id)
SELECT 'rem-' || n, '00000000-0000-4000-8000-0000000005a1', 'Rem Remark', 'Vacation Leave', '2027-02-0' || n, '2027-02-0' || n, 'pending_accountant', '00000000-0000-4000-8000-0000000005f1'
FROM generate_series(1, 5) n;

CREATE TEMP TABLE remark_header (h TEXT);
CREATE FUNCTION pg_temp.header(p JSONB) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.headers', json_build_object('x-sacs-remark', encode(convert_to(p::TEXT, 'UTF8'), 'base64'))::TEXT, true);
$$;
CREATE FUNCTION pg_temp.remarks(p_ids TEXT[]) RETURNS BIGINT LANGUAGE sql AS $$
  SELECT COUNT(*) FROM public.audit_logs WHERE metadata ->> 'kind' = 'decision_remark' AND entity_id = ANY (p_ids);
$$;

DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  -- 1. A bulk decision (one statement, 3 rows): one audit entry per item, code + text + branch.
  PERFORM pg_temp.header(jsonb_build_object('code', 'reject.leave.filed_late', 'text', 'Filed late: ₱ and ñ survive', 'decision', 'reject',
    'entity_type', 'leave_request', 'module', 'leave', 'table', 'leave_requests', 'ids', jsonb_build_array('rem-1', 'rem-2', 'rem-3')));
  UPDATE public.leave_requests SET status = 'rejected' WHERE id IN ('rem-1', 'rem-2', 'rem-3');
  ASSERT pg_temp.remarks(ARRAY['rem-1', 'rem-2', 'rem-3']) = 3, '1: one entry per item';
  ASSERT (SELECT bool_and(metadata ->> 'remark_code' = 'reject.leave.filed_late' AND metadata ->> 'remark_text' = 'Filed late: ₱ and ñ survive'
                          AND branch_id = '00000000-0000-4000-8000-0000000005f1' AND action = 'reject')
          FROM public.audit_logs WHERE entity_id IN ('rem-1', 'rem-2', 'rem-3') AND metadata ->> 'kind' = 'decision_remark'), '1b: code, text, branch';

  -- 2. Rows outside `ids`, and other tables, keep no remark.
  UPDATE public.leave_requests SET reason = 'touched' WHERE id = 'rem-4';
  ASSERT pg_temp.remarks(ARRAY['rem-4']) = 0, '2: not in ids';

  -- 3. A deactivated preset: the decision fails with it (same transaction).
  UPDATE public.remark_presets SET active = FALSE WHERE code = 'reject.leave.school_activity';
  PERFORM pg_temp.header(jsonb_build_object('code', 'reject.leave.school_activity', 'decision', 'reject', 'entity_type', 'leave_request', 'table', 'leave_requests', 'ids', jsonb_build_array('rem-4')));
  v_ok := FALSE;
  BEGIN
    UPDATE public.leave_requests SET status = 'rejected' WHERE id = 'rem-4';
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := TRUE;
  END;
  ASSERT v_ok, '3: deactivated preset refused';
  ASSERT (SELECT status FROM public.leave_requests WHERE id = 'rem-4') = 'pending_accountant', '3b: the decision did not happen';
  ASSERT pg_temp.remarks(ARRAY['rem-4']) = 0, '3c: no entry';

  -- 4. A preset of another decision or type is refused; "other" needs words.
  PERFORM pg_temp.header(jsonb_build_object('code', 'reject.payroll.figures', 'decision', 'reject', 'entity_type', 'leave_request', 'table', 'leave_requests'));
  v_ok := FALSE;
  BEGIN UPDATE public.leave_requests SET status = 'rejected' WHERE id = 'rem-4'; EXCEPTION WHEN invalid_parameter_value THEN v_ok := TRUE; END;
  ASSERT v_ok, '4a: another type''s preset refused';
  PERFORM pg_temp.header(jsonb_build_object('code', 'other', 'text', 'x', 'decision', 'reject', 'entity_type', 'leave_request', 'table', 'leave_requests'));
  v_ok := FALSE;
  BEGIN UPDATE public.leave_requests SET status = 'rejected' WHERE id = 'rem-4'; EXCEPTION WHEN invalid_parameter_value THEN v_ok := TRUE; END;
  ASSERT v_ok, '4b: Other without words refused';

  -- 5. "Other" with words is counted under "other"; a general preset applies to any type.
  PERFORM pg_temp.header(jsonb_build_object('code', 'other', 'text', 'Covered by the principal', 'decision', 'approve', 'entity_type', 'leave_request', 'table', 'leave_requests', 'ids', jsonb_build_array('rem-4')));
  UPDATE public.leave_requests SET status = 'approved' WHERE id = 'rem-4';
  ASSERT (SELECT metadata ->> 'remark_code' FROM public.audit_logs WHERE entity_id = 'rem-4' AND metadata ->> 'kind' = 'decision_remark') = 'other', '5: other';
  PERFORM pg_temp.header(jsonb_build_object('code', 'approve.as_requested', 'decision', 'approve', 'entity_type', 'leave_request', 'table', 'leave_requests', 'ids', jsonb_build_array('rem-5')));
  UPDATE public.leave_requests SET status = 'approved' WHERE id = 'rem-5';
  ASSERT (SELECT metadata ->> 'remark_text' FROM public.audit_logs WHERE entity_id = 'rem-5' AND metadata ->> 'kind' = 'decision_remark') = 'Approved as requested', '5b: the label is the text';

  -- 6. Without the header nothing is written (the current code, before the release).
  PERFORM set_config('request.headers', '{}', true);
  UPDATE public.leave_requests SET reason = 'again' WHERE id = 'rem-5';
  ASSERT pg_temp.remarks(ARRAY['rem-5']) = 1, '6: no header, no entry';

  -- 7. A function that inserts then updates the same row (e.g. attendance_correct_record) counts once.
  PERFORM pg_temp.header(jsonb_build_object('code', 'override.entry_error', 'decision', 'override', 'entity_type', 'leave_request', 'table', 'leave_requests', 'ids', jsonb_build_array('rem-6')));
  INSERT INTO public.leave_requests (id, employee_id, employee_name, start_date, end_date, status, branch_id)
  VALUES ('rem-6', '00000000-0000-4000-8000-0000000005a1', 'Rem Remark', '2027-02-09', '2027-02-09', 'pending_accountant', '00000000-0000-4000-8000-0000000005f1');
  UPDATE public.leave_requests SET status = 'approved' WHERE id = 'rem-6';
  ASSERT pg_temp.remarks(ARRAY['rem-6']) = 1, '7: insert + update of one row = one entry';

  RAISE NOTICE 'all remark preset scenarios passed';
END $$;

ROLLBACK;
