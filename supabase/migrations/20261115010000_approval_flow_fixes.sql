-- Payroll approval flow fixes (decisions 2026-11-15, verification report).
--
--  1. Drafts never block a submission: a Draft is left out of the run (it is
--     never one of the run's payslips) and listed with the left-out employees.
--  2. A Final payslip outside the branch's active list (e.g. an archived
--     account) goes in only when the Accountant ticks it; one left out must
--     be listed as left out, so nothing is ever dropped silently. On a
--     resubmission, a payslip no longer in the run is released from it.
--     payroll_run_exclusions.left_out_as says why someone is not in the run.
--  3. A payslip belongs to the branch and run it was processed in: once in a
--     run, its branch never changes (an employee's branch move only affects
--     payslips not in a run yet).
--  4. Notifications: HR's "run submitted" notice names how many were left
--     out and who, and shows the real net total (the amount filter of
--     20261109100000 skips this HR-only notice, decision 2026-11-15 #8).
--     Each employee of an approved run is told the payslip is ready by the
--     database itself, so every approver path (HR, the Super Admin fallback)
--     sends it.
-- Additive: functions replaced in place, one nullable column, one trigger.

-- ── 1. Why an employee is not in the run ────────────────────────────────
ALTER TABLE public.payroll_run_exclusions ADD COLUMN IF NOT EXISTS left_out_as TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_run_exclusions_left_out_as_check') THEN
    ALTER TABLE public.payroll_run_exclusions ADD CONSTRAINT payroll_run_exclusions_left_out_as_check
      CHECK (left_out_as IS NULL OR left_out_as IN ('not_processed', 'draft', 'outside_list'));
  END IF;
END $$;

-- ── 2. Submit ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_payroll_run(p_run_id uuid, p_actor uuid, p_items jsonb, p_exclusions jsonb DEFAULT '[]'::jsonb)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_from TEXT;
  v_eligible UUID[];
  v_given UUID[];
  v_bad TEXT;
  v_hr UUID[];
  v_branch TEXT;
  v_left_count INTEGER;
  v_left_names TEXT;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;

  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'accountant' THEN
    RAISE EXCEPTION 'forbidden: only an Accountant submits payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role = 'accountant' AND v_actor.branch_id IS DISTINCT FROM v_run.branch_id THEN
    RAISE EXCEPTION 'forbidden: that is another branch''s payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_run.status NOT IN ('draft', 'rejected') THEN
    RAISE EXCEPTION 'invalid_transition: this run is % and cannot be submitted.', v_run.status USING ERRCODE = 'check_violation';
  END IF;

  -- Drafts no longer block (2026-11-15): a Draft is never one of the run's
  -- payslips (only Final ones are), and its employee is listed as left out.

  -- The Final payslips this run may hold: not already in another run of the
  -- period (a supplemental run holds only the employees processed late).
  SELECT array_agg(e.id ORDER BY e.id) INTO v_eligible FROM public.payroll_entries e
  WHERE e.branch_id = v_run.branch_id AND e.pay_period = v_run.period_label AND e.status::TEXT = 'paid'
    AND (e.run_id IS NULL OR e.run_id = v_run.id);
  IF v_eligible IS NULL THEN
    RAISE EXCEPTION 'nothing_processed: no Final payslip in this run yet.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(DISTINCT (x->>'entry_id')::UUID ORDER BY (x->>'entry_id')::UUID) INTO v_given
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) x;
  IF v_given IS NULL THEN
    RAISE EXCEPTION 'nothing_processed: choose at least one Final payslip for this run.' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(v_given) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'snapshot_mismatch: a payslip is listed twice.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (v_given <@ v_eligible) THEN
    RAISE EXCEPTION 'snapshot_mismatch: the snapshot holds a payslip that is not one of this run''s Final payslips.' USING ERRCODE = 'check_violation';
  END IF;
  -- A Final payslip left out of the run is listed as left out: never silently.
  SELECT e.employee_name INTO v_bad FROM public.payroll_entries e
  WHERE e.id = ANY (v_eligible) AND e.id <> ALL (v_given)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_exclusions, '[]'::JSONB)) x
                    WHERE NULLIF(x->>'employee_id', '')::UUID = e.employee_id)
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot_mismatch: % has a Final payslip that is neither in the run nor listed as left out.', v_bad USING ERRCODE = 'check_violation';
  END IF;

  -- Every figure HR will approve equals the payslip's own.
  SELECT x->>'employee_name' INTO v_bad
  FROM jsonb_array_elements(p_items) x
  JOIN public.payroll_entries e ON e.id = (x->>'entry_id')::UUID
  WHERE (x->>'employee_id')::UUID IS DISTINCT FROM e.employee_id
     OR round(COALESCE((x->>'net_pay')::NUMERIC, 0), 2) <> round(GREATEST(COALESCE((e.payroll->'totals'->>'net_pay')::NUMERIC, 0), 0), 2)
     OR round(COALESCE((x->>'total_deductions')::NUMERIC, 0), 2) <> round(COALESCE((e.payroll->'totals'->>'total_deductions')::NUMERIC, 0), 2)
     OR round(COALESCE((x->>'gross_pay')::NUMERIC, 0), 2) <> round(COALESCE((e.payroll->'totals'->>'gross_pay')::NUMERIC, 0)
                                                           + COALESCE((e.payroll->'totals'->>'total_incentives')::NUMERIC, 0), 2)
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot_mismatch: % does not match the payslip.', v_bad USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  v_from := v_run.status;

  INSERT INTO public.payroll_run_items (
    run_id, submission_no, entry_id, employee_id, employee_name, employee_code, employee_level, schedule_name, payslip_no,
    processed_by, basic_pay, gross_pay, total_deductions, net_pay, attendance_deduction, absence_deduction, late_deduction,
    undertime_deduction, half_day_deduction, leave_without_pay_deduction, withholding_tax, sss, philhealth, pagibig, loans,
    other_deductions, early_bird_incentive, total_incentives, days_worked, absent_days, late_days, late_minutes,
    undertime_minutes, half_days, previous_net_pay, flags, breakdown
  )
  SELECT v_run.id, v_run.submission_no + 1, x.entry_id, x.employee_id, x.employee_name, x.employee_code, x.employee_level,
         x.schedule_name, e.payslip_no,
         (SELECT r.processed_by FROM public.payroll_records r
           WHERE r.employee_id = x.employee_id AND r.period_label = v_run.period_label AND r.archived = FALSE
           ORDER BY r.processed_at DESC LIMIT 1),
         x.basic_pay, x.gross_pay, x.total_deductions, x.net_pay, x.attendance_deduction, x.absence_deduction, x.late_deduction,
         x.undertime_deduction, x.half_day_deduction, x.leave_without_pay_deduction, x.withholding_tax, x.sss, x.philhealth,
         x.pagibig, x.loans, x.other_deductions, x.early_bird_incentive, x.total_incentives, x.days_worked, x.absent_days,
         x.late_days, x.late_minutes, x.undertime_minutes, x.half_days, x.previous_net_pay, COALESCE(x.flags, '{}'),
         COALESCE(x.breakdown, '{}'::JSONB)
  FROM jsonb_to_recordset(p_items) AS x(
    entry_id UUID, employee_id UUID, employee_name TEXT, employee_code TEXT, employee_level TEXT, schedule_name TEXT,
    basic_pay NUMERIC, gross_pay NUMERIC, total_deductions NUMERIC, net_pay NUMERIC, attendance_deduction NUMERIC,
    absence_deduction NUMERIC, late_deduction NUMERIC, undertime_deduction NUMERIC, half_day_deduction NUMERIC,
    leave_without_pay_deduction NUMERIC, withholding_tax NUMERIC, sss NUMERIC, philhealth NUMERIC, pagibig NUMERIC,
    loans NUMERIC, other_deductions NUMERIC, early_bird_incentive NUMERIC, total_incentives NUMERIC, days_worked NUMERIC,
    absent_days NUMERIC, late_days NUMERIC, late_minutes NUMERIC, undertime_minutes NUMERIC, half_days NUMERIC,
    previous_net_pay NUMERIC, flags TEXT[], breakdown JSONB
  )
  JOIN public.payroll_entries e ON e.id = x.entry_id;

  -- A payslip of the earlier snapshot that is not in this one leaves the run.
  UPDATE public.payroll_entries SET run_id = NULL WHERE run_id = v_run.id AND id <> ALL (v_given);
  UPDATE public.payroll_entries SET run_id = v_run.id WHERE id = ANY (v_given);

  -- Who was left out of this snapshot, acknowledged by the Accountant.
  INSERT INTO public.payroll_run_exclusions (run_id, submission_no, employee_id, employee_name, employee_code, reason, acknowledged_by, acknowledged_by_name, left_out_as)
  SELECT v_run.id, v_run.submission_no + 1, (x->>'employee_id')::UUID, COALESCE(NULLIF(btrim(x->>'employee_name'), ''), p.full_name, 'Employee'),
         NULLIF(btrim(COALESCE(x->>'employee_code', '')), ''), NULLIF(left(btrim(COALESCE(x->>'reason', '')), 500), ''), v_actor.id, v_actor.full_name,
         CASE WHEN x->>'left_out_as' IN ('not_processed', 'draft', 'outside_list') THEN x->>'left_out_as' END
  FROM jsonb_array_elements(COALESCE(p_exclusions, '[]'::JSONB)) x
  LEFT JOIN public.profiles p ON p.id = (x->>'employee_id')::UUID
  WHERE NULLIF(x->>'employee_id', '') IS NOT NULL
  ON CONFLICT (run_id, submission_no, employee_id) DO NOTHING;

  UPDATE public.payroll_runs r SET
    status = 'pending',
    submission_no = v_run.submission_no + 1,
    submitted_by = v_actor.id,
    submitted_by_name = v_actor.full_name,
    submitted_at = NOW(),
    processed_by = COALESCE(r.processed_by, v_actor.id),
    processed_by_name = COALESCE(r.processed_by_name, v_actor.full_name),
    reviewed_by = NULL, reviewed_by_name = NULL, reviewed_at = NULL, remarks = NULL,
    total_employees = t.n, total_gross = t.gross, total_deductions = t.deductions, total_net = t.net
  FROM (
    SELECT count(*) AS n, COALESCE(sum(i.gross_pay), 0) AS gross, COALESCE(sum(i.total_deductions), 0) AS deductions,
           COALESCE(sum(i.net_pay), 0) AS net
    FROM public.payroll_run_items i WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no + 1
  ) t
  WHERE r.id = v_run.id
  RETURNING r.* INTO v_run;

  PERFORM public.payroll_run_record(v_run, CASE WHEN v_from = 'rejected' THEN 'resubmitted' ELSE 'submitted' END, v_from,
    v_actor.id, v_actor.role, v_actor.full_name, NULL);

  -- HR's notice: the left-out count and names (the first ten), and the net.
  SELECT count(*), string_agg(name, ', ' ORDER BY name) FILTER (WHERE rn <= 10) INTO v_left_count, v_left_names
  FROM (SELECT x.employee_name AS name, row_number() OVER (ORDER BY x.employee_name) AS rn
        FROM public.payroll_run_exclusions x WHERE x.run_id = v_run.id AND x.submission_no = v_run.submission_no) s;

  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  SELECT array_agg(p.id) INTO v_hr FROM public.profiles p
  WHERE lower(p.role::TEXT) = 'hr' AND COALESCE(p.archived, FALSE) = FALSE;
  PERFORM public.payroll_run_notify(v_hr, 'payroll_run_submitted',
    format('Payroll waiting for approval: %s', COALESCE(v_branch, 'a branch')),
    format('%s · %s employee%s · net ₱%s · %s by %s%s', v_run.period_label, v_run.total_employees,
      CASE WHEN v_run.total_employees = 1 THEN '' ELSE 's' END,
      to_char(v_run.total_net, 'FM999,999,990.00'), CASE WHEN v_from = 'rejected' THEN 'resubmitted' ELSE 'submitted' END, v_actor.full_name,
      CASE WHEN v_left_count > 0
        THEN format(' · %s left out: %s%s', v_left_count, v_left_names, CASE WHEN v_left_count > 10 THEN format(' and %s more', v_left_count - 10) ELSE '' END)
        ELSE ' · nobody left out' END),
    'hr-payroll-approval', v_run.id);
  RETURN v_run;
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_payroll_run(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_payroll_run(uuid, uuid, jsonb, jsonb) TO service_role;

-- ── 3. Approve: every approver path tells the employees ──────────────────
CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid, p_actor uuid, p_remarks text DEFAULT NULL::text)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_branch TEXT;
  v_remarks TEXT := NULLIF(btrim(COALESCE(p_remarks, '')), '');
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  -- 2026-11-10: HR, or the Super Admin only when no other HR may decide (fallback).
  IF v_actor.id IS NULL OR NOT (v_actor.role = 'hr' OR (v_actor.role = 'super_admin' AND private.payroll_run_needs_fallback(v_run.id))) THEN
    RAISE EXCEPTION 'forbidden: only HR approves payroll (the Super Admin only when no other HR is active).' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Nobody decides a run that holds their own payslip.
  IF EXISTS (SELECT 1 FROM public.payroll_run_items i WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no AND i.employee_id = v_actor.id) THEN
    RAISE EXCEPTION 'own_payslip: this run holds your own payslip, so another HR must decide it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The shared HR queue: an item another HR claimed is theirs until released or expired.
  PERFORM private.hr_claim_check('payroll_run', v_run.id, v_actor.id);
  IF v_run.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this run is % and cannot be approved.', v_run.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_actor.id IN (v_run.processed_by, v_run.submitted_by) OR EXISTS (
    SELECT 1 FROM public.payroll_run_items i
    WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no AND i.processed_by = v_actor.id
  ) THEN
    RAISE EXCEPTION 'self_approval: you processed this payroll, so someone else must approve it.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  UPDATE public.payroll_runs SET status = 'approved', reviewed_by = v_actor.id, reviewed_by_name = v_actor.full_name,
         reviewed_at = NOW(), remarks = v_remarks
  WHERE id = v_run.id RETURNING * INTO v_run;

  UPDATE public.payroll_entries SET approved_by = v_actor.id, approved_at = NOW() WHERE run_id = v_run.id;

  -- The Early Bird winner of the period is final from now on.
  IF to_regclass('public.early_bird_winners') IS NOT NULL THEN
    UPDATE public.early_bird_winners SET finalized_at = NOW()
    WHERE period_label = v_run.period_label AND finalized_at IS NULL;
  END IF;

  PERFORM public.payroll_run_record(v_run, 'approved', 'pending', v_actor.id, v_actor.role, v_actor.full_name, v_remarks);
  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  PERFORM public.payroll_run_notify(ARRAY[v_run.processed_by, v_run.submitted_by], 'payroll_run_approved',
    format('Payroll approved: %s, %s', COALESCE(v_branch, 'branch'), v_run.period_label),
    format('Approved by %s. Payslips are now visible to employees.%s', v_actor.full_name,
      CASE WHEN v_remarks IS NOT NULL THEN ' Note: ' || v_remarks ELSE '' END),
    'ac-process', v_run.id);
  -- Each employee of the approved snapshot: the payslip is ready (no amounts).
  PERFORM public.payroll_run_notify(ARRAY(SELECT i.employee_id FROM public.payroll_run_items i
      WHERE i.run_id = v_run.id AND i.submission_no = v_run.submission_no),
    'payslip_released', 'Your payslip is ready',
    format('Your payslip for %s was approved by HR.', v_run.period_label),
    'emp-payslips', v_run.id);
  RETURN v_run;
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_payroll_run(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(uuid, uuid, text) TO service_role;

-- ── 4. HR's run notice keeps its net total ───────────────────────────────
CREATE OR REPLACE FUNCTION public.notifications_strip_amounts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- HR's "run submitted" notice shows the run's net (decision 2026-11-15 #8).
  IF NEW.kind = 'payroll_run_submitted' THEN
    RETURN NEW;
  END IF;
  NEW.title := public.notification_text_without_amounts(NEW.title);
  NEW.body := public.notification_text_without_amounts(NEW.body);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notifications_strip_amounts() FROM PUBLIC, anon, authenticated;

-- ── 5. A payslip in a run stays with its branch ─────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_entries_follow_employee_branch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch UUID;
BEGIN
  IF COALESCE(current_setting('sacs.payroll_commit', true), '') <> 'on' OR public.payroll_run_action_on() THEN
    RETURN NEW;
  END IF;
  -- In a run (any status): it belongs to the branch and run it was processed in.
  IF OLD.run_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.branch_id INTO v_branch FROM public.profiles p WHERE p.id = NEW.employee_id;
  IF v_branch IS NULL OR v_branch IS NOT DISTINCT FROM OLD.branch_id THEN
    RETURN NEW;
  END IF;
  IF public.payroll_entry_run_status(OLD.run_id, OLD.branch_id, OLD.pay_period) IN ('pending', 'approved') THEN
    RETURN NEW;
  END IF;
  NEW.branch_id := v_branch;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.payroll_entries_branch_stays_with_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.run_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    RAISE EXCEPTION 'payslip_in_run: the % payslip of % is in a payroll run of its branch, so it stays with that branch.',
      OLD.pay_period, COALESCE(OLD.employee_name, OLD.employee_id::text) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.payroll_entries_branch_stays_with_run() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_entries_zw_branch_stays_with_run ON public.payroll_entries;
-- Plain BEFORE UPDATE (not "OF branch_id"): also catches a branch another trigger sets.
CREATE TRIGGER payroll_entries_zw_branch_stays_with_run BEFORE UPDATE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_branch_stays_with_run();
