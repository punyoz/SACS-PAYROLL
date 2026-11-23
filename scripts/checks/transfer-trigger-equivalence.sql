-- ═══════════════════════════════════════════════════════════════════════════
-- Equivalence check for the transfer approval trigger change (20261124070000).
-- Runs the same cases under the OLD function and the NEW one, in one rolled-back
-- transaction, and asserts the same outcome: status, reviewed_at set or not, and
-- the employee's branch. Cases: pending -> approved (no date, and today), pending
-- -> rejected, pending untouched, approved -> approved again (already applied).
-- Then the new behavior only: a later date waits (and the old one did not).
-- Works on any database with the new migration applied (the local test stack,
-- or a local copy of the live backup).
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/transfer-trigger-equivalence.sql
-- Ends with NOTICE "transfer trigger: old and new behave the same".
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-0000000fe00' || n)::UUID, 'eq' || n || '@tr.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 6) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name) VALUES
  ('00000000-0000-4000-8000-0000000fef01', 'Eq From'), ('00000000-0000-4000-8000-0000000fef02', 'Eq To') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, archived, on_payroll, employee_status)
SELECT ('00000000-0000-4000-8000-0000000fe00' || n)::UUID, 'eq' || n || '@tr.test', 'Eq Person ' || n, (CASE WHEN n = 6 THEN 'hr' ELSE 'employee' END)::public.user_role,
       CASE WHEN n = 6 THEN NULL ELSE '00000000-0000-4000-8000-0000000fef01'::UUID END, FALSE, TRUE, 'Active'
FROM generate_series(1, 6) n
ON CONFLICT (id) DO UPDATE SET branch_id = EXCLUDED.branch_id, role = EXCLUDED.role, archived = FALSE;

CREATE TEMP TABLE outcomes (mode TEXT, case_name TEXT, status TEXT, reviewed BOOLEAN, branch UUID);

-- The new function's text, to put it back after running the old one.
CREATE TEMP TABLE new_def AS SELECT pg_get_functiondef('public.apply_transfer_request_approval'::regproc) AS def;

CREATE OR REPLACE FUNCTION pg_temp.run_cases(p_mode TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  hr CONSTANT UUID := '00000000-0000-4000-8000-0000000fe006';
  f CONSTANT UUID := '00000000-0000-4000-8000-0000000fef01';
  t CONSTANT UUID := '00000000-0000-4000-8000-0000000fef02';
  today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  r UUID;
  c RECORD;
BEGIN
  -- Fresh start for every mode.
  UPDATE public.profiles SET branch_id = f WHERE id IN ('00000000-0000-4000-8000-0000000fe001', '00000000-0000-4000-8000-0000000fe002',
    '00000000-0000-4000-8000-0000000fe003', '00000000-0000-4000-8000-0000000fe004', '00000000-0000-4000-8000-0000000fe005');
  DELETE FROM public.transfer_requests WHERE employee_id::TEXT LIKE '00000000-0000-4000-8000-0000000fe00%';
  FOR c IN SELECT * FROM (VALUES
      ('approve_no_date', '00000000-0000-4000-8000-0000000fe001'::UUID, NULL::DATE, 'approved'),
      ('approve_today',   '00000000-0000-4000-8000-0000000fe002'::UUID, today,       'approved'),
      ('reject',          '00000000-0000-4000-8000-0000000fe003'::UUID, NULL::DATE, 'rejected'),
      ('pending',         '00000000-0000-4000-8000-0000000fe004'::UUID, NULL::DATE, 'pending'),
      ('approve_twice',   '00000000-0000-4000-8000-0000000fe005'::UUID, NULL::DATE, 'approved')) v(case_name, emp, eff, to_status) LOOP
    INSERT INTO public.transfer_requests (employee_id, from_branch_id, to_branch_id, requested_by, effective_date) VALUES (c.emp, f, t, hr, c.eff) RETURNING id INTO r;
    IF c.to_status <> 'pending' THEN
      UPDATE public.transfer_requests SET status = c.to_status::public.transfer_request_status, reviewed_by = hr WHERE id = r;
    END IF;
    IF c.case_name = 'approve_twice' THEN
      -- Already applied: someone moves the employee back by hand, then the approved row is touched again (remarks).
      UPDATE public.profiles SET branch_id = f WHERE id = c.emp;
      UPDATE public.transfer_requests SET remarks = 'touched again' WHERE id = r;
    END IF;
    INSERT INTO outcomes SELECT p_mode, c.case_name, q.status::TEXT, q.reviewed_at IS NOT NULL, p.branch_id
      FROM public.transfer_requests q JOIN public.profiles p ON p.id = q.employee_id WHERE q.id = r;
  END LOOP;
END $$;

-- OLD function (word for word from 20260910010000).
CREATE OR REPLACE FUNCTION public.apply_transfer_request_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_at := NOW();

    UPDATE public.profiles
    SET branch_id = NEW.to_branch_id, updated_at = NOW()
    WHERE id = NEW.employee_id;
  END IF;

  RETURN NEW;
END;
$$;
SELECT pg_temp.run_cases('old');

-- NEW function (as the migration defines it).
DO $$ BEGIN EXECUTE (SELECT def FROM new_def); END $$;
SELECT pg_temp.run_cases('new');

DO $$
DECLARE
  d RECORD;
  n INTEGER := 0;
BEGIN
  FOR d IN SELECT o.case_name, o.status AS os, n2.status AS ns, o.reviewed AS orv, n2.reviewed AS nrv, o.branch AS ob, n2.branch AS nb
           FROM outcomes o JOIN outcomes n2 ON n2.case_name = o.case_name AND n2.mode = 'new' WHERE o.mode = 'old' LOOP
    ASSERT d.os = d.ns AND d.orv = d.nrv AND d.ob IS NOT DISTINCT FROM d.nb,
      format('%s differs: old (%s, reviewed %s, branch %s) vs new (%s, reviewed %s, branch %s)', d.case_name, d.os, d.orv, d.ob, d.ns, d.nrv, d.nb);
    n := n + 1;
  END LOOP;
  ASSERT n = 5, format('5 cases compared, got %s', n);

  -- The one intended difference: a later date waits under the new function.
  INSERT INTO public.transfer_requests (employee_id, from_branch_id, to_branch_id, requested_by, effective_date)
  VALUES ('00000000-0000-4000-8000-0000000fe001', '00000000-0000-4000-8000-0000000fef02', '00000000-0000-4000-8000-0000000fef01', '00000000-0000-4000-8000-0000000fe006',
          (now() AT TIME ZONE 'Asia/Manila')::DATE + 5);
  UPDATE public.profiles SET branch_id = '00000000-0000-4000-8000-0000000fef02' WHERE id = '00000000-0000-4000-8000-0000000fe001';
  UPDATE public.transfer_requests SET status = 'approved', reviewed_by = '00000000-0000-4000-8000-0000000fe006'
  WHERE employee_id = '00000000-0000-4000-8000-0000000fe001' AND effective_date IS NOT NULL AND status = 'pending';
  ASSERT (SELECT branch_id FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000fe001') = '00000000-0000-4000-8000-0000000fef02', 'a later date waits (new only)';
  RAISE NOTICE 'transfer trigger: old and new behave the same';
END $$;

ROLLBACK;
