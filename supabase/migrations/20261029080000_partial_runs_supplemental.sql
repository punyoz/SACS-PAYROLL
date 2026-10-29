-- Partial payroll runs and supplemental runs (2026-10-29).
--
-- The Accountant may submit a branch's run without every employee, once they
-- confirm who is left out and why; the list goes to HR with the run and stays
-- on record (payroll_run_exclusions). An employee left out is processed later
-- in a SUPPLEMENTAL run of the same branch and period (run_no 2, 3, ...),
-- which HR approves on its own before that employee sees the payslip.
--
--   payroll_runs.run_no              1 = the period's run, 2+ = supplemental
--   payroll_run_exclusions           who each submitted snapshot left out
--   ensure_payroll_run()             opens a supplemental run once the latest is approved
--                                    and new Final payslips are waiting
--   submit_payroll_run(…, p_exclusions)
--                                    snapshots the Final payslips not already in
--                                    another run; stores the exclusions
--   payroll_entry_run_status()       the run that locks a payslip: its own run,
--                                    else the period's latest run while pending
--   payroll_run_lock_guard()         uses it: an approved run's payslips stay locked;
--                                    a late payslip for that period may be written
--   payroll_override_final(),
--   payroll_entries_follow_employee_branch()
--                                    read the payslip's own run
--
-- Safe to run more than once.

ALTER TABLE public.payroll_runs ADD COLUMN IF NOT EXISTS run_no INTEGER NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_run_no_check') THEN
    ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_run_no_check CHECK (run_no >= 1);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_one_per_branch_period') THEN
    ALTER TABLE public.payroll_runs DROP CONSTRAINT payroll_runs_one_per_branch_period;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_one_per_branch_period_run') THEN
    ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_one_per_branch_period_run UNIQUE (branch_id, period_start, run_no);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.payroll_run_exclusions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  submission_no        INTEGER NOT NULL,
  employee_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  employee_name        TEXT NOT NULL,
  employee_code        TEXT,
  reason               TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  acknowledged_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_by_name TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, submission_no, employee_id)
);
CREATE INDEX IF NOT EXISTS payroll_run_exclusions_employee_idx ON public.payroll_run_exclusions (employee_id);
ALTER TABLE public.payroll_run_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_run_exclusions FROM anon, authenticated;

-- Never edited or removed: the record of who a submitted run left out.
CREATE OR REPLACE FUNCTION public.payroll_run_exclusions_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $f$
BEGIN
  RAISE EXCEPTION 'payroll_run_exclusions are kept as submitted.' USING ERRCODE = 'check_violation';
END;
$f$;
DROP TRIGGER IF EXISTS payroll_run_exclusions_keep ON public.payroll_run_exclusions;
CREATE TRIGGER payroll_run_exclusions_keep BEFORE UPDATE OR DELETE ON public.payroll_run_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_exclusions_guard();

-- The period's latest run (supplemental runs come after the first).
CREATE OR REPLACE FUNCTION public.payroll_run_status_for(p_branch uuid, p_label text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT r.status FROM public.payroll_runs r
  WHERE r.branch_id = p_branch AND r.period_label = p_label
  ORDER BY r.run_no DESC
  LIMIT 1;
$function$;

-- The run status that locks a payslip: its own run when it is in one;
-- otherwise the period's latest run while it waits for HR (an approved
-- latest run leaves room for a supplemental run).
CREATE OR REPLACE FUNCTION public.payroll_entry_run_status(p_run_id uuid, p_branch uuid, p_label text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_run_id IS NOT NULL THEN COALESCE((SELECT r.status FROM public.payroll_runs r WHERE r.id = p_run_id), 'draft')
    ELSE CASE COALESCE(public.payroll_run_status_for(p_branch, p_label), 'draft') WHEN 'pending' THEN 'pending' ELSE 'draft' END
  END;
$function$;

CREATE OR REPLACE FUNCTION public.payroll_run_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch UUID;
  v_label TEXT;
  v_run UUID;
  v_status TEXT;
BEGIN
  IF public.payroll_run_action_on() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'payroll_entries' THEN
    v_branch := COALESCE(NEW.branch_id, OLD.branch_id);
    v_label := COALESCE(NEW.pay_period, OLD.pay_period);
    v_run := COALESCE(OLD.run_id, NEW.run_id);
  ELSE
    v_branch := COALESCE(NEW.branch_id, OLD.branch_id);
    v_label := COALESCE(NEW.period_label, OLD.period_label);
    -- A payroll record follows the employee's payslip for the period.
    SELECT e.run_id INTO v_run FROM public.payroll_entries e
    WHERE e.employee_id = COALESCE(NEW.employee_id, OLD.employee_id) AND e.pay_period = v_label AND e.run_id IS NOT NULL
    LIMIT 1;
  END IF;
  v_status := public.payroll_entry_run_status(v_run, v_branch, v_label);
  IF v_status IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'payroll_run_locked: the % payroll of this branch is % and cannot be changed.',
      v_label, CASE v_status WHEN 'pending' THEN 'waiting for HR approval' ELSE 'approved' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- The run to submit: the latest of the period, or a new supplemental run
-- when the latest is approved and Final payslips are waiting outside it.
CREATE OR REPLACE FUNCTION public.ensure_payroll_run(p_branch uuid, p_period_label text, p_actor uuid)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start DATE := public.payroll_period_start(p_period_label);
  v_label TEXT;
  v_actor RECORD;
  v_run public.payroll_runs;
BEGIN
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'invalid_period: % is not a pay period.', p_period_label USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_label := public.payroll_period_label(v_start);
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'accountant' THEN
    RAISE EXCEPTION 'forbidden: only an Accountant starts a payroll run.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role = 'accountant' AND v_actor.branch_id IS DISTINCT FROM p_branch THEN
    RAISE EXCEPTION 'forbidden: that is another branch''s payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE branch_id = p_branch AND period_start = v_start
  ORDER BY run_no DESC LIMIT 1;
  IF v_run.id IS NOT NULL AND (v_run.status <> 'approved' OR NOT EXISTS (
    SELECT 1 FROM public.payroll_entries e
    WHERE e.branch_id = p_branch AND e.pay_period = v_label AND e.status::TEXT = 'paid' AND e.run_id IS NULL
  )) THEN
    RETURN v_run;
  END IF;

  INSERT INTO public.payroll_runs (branch_id, period_label, period_start, period_end, cutoff_type, status, processed_by, processed_by_name, run_no)
  VALUES (
    p_branch, v_label, v_start,
    CASE WHEN EXTRACT(DAY FROM v_start) = 1 THEN v_start + 14 ELSE (date_trunc('month', v_start) + INTERVAL '1 month - 1 day')::DATE END,
    CASE WHEN EXTRACT(DAY FROM v_start) = 1 THEN 'first' ELSE 'second' END,
    'draft', v_actor.id, v_actor.full_name, COALESCE(v_run.run_no, 0) + 1
  )
  ON CONFLICT (branch_id, period_start, run_no) DO NOTHING;
  SELECT * INTO v_run FROM public.payroll_runs WHERE branch_id = p_branch AND period_start = v_start
  ORDER BY run_no DESC LIMIT 1;
  RETURN v_run;
END;
$function$;

DROP FUNCTION IF EXISTS public.submit_payroll_run(uuid, uuid, jsonb);
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
  v_expected UUID[];
  v_given UUID[];
  v_bad TEXT;
  v_hr UUID[];
  v_branch TEXT;
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

  IF EXISTS (SELECT 1 FROM public.payroll_entries e
             WHERE e.branch_id = v_run.branch_id AND e.pay_period = v_run.period_label AND e.status::TEXT = 'draft') THEN
    RAISE EXCEPTION 'drafts_open: finish or cancel the Draft payslips of this run first.' USING ERRCODE = 'check_violation';
  END IF;

  -- This run's payslips: the Final ones not already in another run of the
  -- period (a supplemental run holds only the employees processed late).
  SELECT array_agg(e.id ORDER BY e.id) INTO v_expected FROM public.payroll_entries e
  WHERE e.branch_id = v_run.branch_id AND e.pay_period = v_run.period_label AND e.status::TEXT = 'paid'
    AND (e.run_id IS NULL OR e.run_id = v_run.id);
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'nothing_processed: no Final payslip in this run yet.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg((x->>'entry_id')::UUID ORDER BY (x->>'entry_id')::UUID) INTO v_given FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) x;
  IF v_given IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'snapshot_mismatch: the snapshot must cover exactly the run''s Final payslips.' USING ERRCODE = 'check_violation';
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

  UPDATE public.payroll_entries SET run_id = v_run.id WHERE id = ANY (v_expected);

  -- Who was left out of this snapshot, acknowledged by the Accountant.
  INSERT INTO public.payroll_run_exclusions (run_id, submission_no, employee_id, employee_name, employee_code, reason, acknowledged_by, acknowledged_by_name)
  SELECT v_run.id, v_run.submission_no + 1, (x->>'employee_id')::UUID, COALESCE(NULLIF(btrim(x->>'employee_name'), ''), p.full_name, 'Employee'),
         NULLIF(btrim(COALESCE(x->>'employee_code', '')), ''), NULLIF(left(btrim(COALESCE(x->>'reason', '')), 500), ''), v_actor.id, v_actor.full_name
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

  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  SELECT array_agg(p.id) INTO v_hr FROM public.profiles p
  WHERE lower(p.role::TEXT) = 'hr' AND COALESCE(p.archived, FALSE) = FALSE;
  PERFORM public.payroll_run_notify(v_hr, 'payroll_run_submitted',
    format('Payroll waiting for approval: %s', COALESCE(v_branch, 'a branch')),
    format('%s · %s employees · net %s · %s by %s', v_run.period_label, v_run.total_employees,
      to_char(v_run.total_net, 'FM999,999,990.00'), CASE WHEN v_from = 'rejected' THEN 'resubmitted' ELSE 'submitted' END, v_actor.full_name),
    'hr-payroll-approval', v_run.id);
  RETURN v_run;
END;
$function$;

CREATE OR REPLACE FUNCTION public.payroll_override_final(p_actor uuid, p_item jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor        public.profiles;
  v_reason       TEXT := btrim(COALESCE(p_reason, ''));
  v_employee     UUID := NULLIF(p_item #>> '{entry,employee_id}', '')::UUID;
  v_period       TEXT := p_item #>> '{entry,pay_period}';
  v_old          public.payroll_entries;
  v_new          public.payroll_entries;
  v_run          public.payroll_runs;
  v_old_values   JSONB;
  v_new_values   JSONB;
  v_changed      TEXT[];
  v_result       JSONB;
  v_override     UUID;
  v_year         INTEGER;
  v_month        TEXT;
  v_flags        JSONB := '[]'::JSONB;
  v_flag_count   INTEGER;
  v_statutory    BOOLEAN;
  v_tax          BOOLEAN;
  r              RECORD;
BEGIN
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor;
  IF v_actor.id IS NULL OR COALESCE(v_actor.archived, FALSE) OR lower(COALESCE(v_actor.role::TEXT, '')) <> 'super_admin' THEN
    RAISE EXCEPTION 'forbidden: only a Super Admin can override a Final payslip.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'override_reason_required: give a reason for the override (at least 10 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF v_employee IS NULL OR v_period IS NULL THEN
    RAISE EXCEPTION 'invalid: the override names no employee or pay period.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_old FROM public.payroll_entries
   WHERE employee_id = v_employee AND pay_period = v_period
   FOR UPDATE;
  IF v_old.id IS NULL OR v_old.status IS DISTINCT FROM 'paid'::public.payroll_state THEN
    RAISE EXCEPTION 'override_not_final: only a Final payslip can be overridden; a Draft is regenerated in Process Payroll.' USING ERRCODE = 'check_violation';
  END IF;

  -- Only a payslip HR has approved: one still in the Accountant -> HR flow
  -- (Draft, Pending, Rejected) is corrected there, never by an override.
  -- The payslip's own run: a period can also have a supplemental run (20261029080000).
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = v_old.run_id;
  IF public.payroll_period_requires_approval(v_period) AND v_run.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'override_not_approved: the % payroll of this branch is %; correct it through Process Payroll and Payroll Approval instead.',
      v_period, CASE COALESCE(v_run.status, '') WHEN 'pending' THEN 'waiting for HR approval' WHEN 'rejected' THEN 'sent back by HR' WHEN '' THEN 'not submitted' ELSE v_run.status END
      USING ERRCODE = 'check_violation';
  END IF;

  v_old_values := public.payroll_override_values(v_old);

  -- The run lock and the Final lock let this transaction through, and only it.
  PERFORM set_config('sacs.payroll_run_action', 'on', true);

  -- The replaced payroll record is archived (kept), as for every override.
  UPDATE public.payroll_records SET archived = TRUE
   WHERE employee_id = v_employee AND period_label = v_period AND NOT archived;

  v_result := public.payroll_commit_entries(jsonb_build_array(p_item)) -> 0;
  IF NOT COALESCE((v_result ->> 'ok')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'override_not_saved: %', COALESCE(v_result ->> 'error', 'the payslip was not written') USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_new FROM public.payroll_entries WHERE employee_id = v_employee AND pay_period = v_period;
  v_new_values := public.payroll_override_values(v_new);
  SELECT COALESCE(array_agg(k ORDER BY k), '{}') INTO v_changed
    FROM jsonb_object_keys(v_old_values) k
   WHERE k <> 'payslip_no' AND (v_old_values -> k) IS DISTINCT FROM (v_new_values -> k);

  INSERT INTO public.payroll_final_overrides (entry_id, employee_id, employee_name, branch_id, pay_period, run_id, run_status,
    reason, old_payslip_no, new_payslip_no, old_values, new_values, changed_fields, actor_id, actor_name, actor_role)
  VALUES (v_new.id, v_employee, v_new.employee_name, v_new.branch_id, v_period, v_run.id, v_run.status,
    v_reason, v_old.payslip_no, v_new.payslip_no, v_old_values, v_new_values, v_changed, v_actor.id, v_actor.full_name, 'super_admin')
  RETURNING id INTO v_override;

  -- ── Records that relied on the old figures: flagged, never changed ─────
  IF cardinality(v_changed) > 0 THEN
    v_year := EXTRACT(YEAR FROM public.payroll_period_start(v_period))::INTEGER;
    v_month := to_char(public.payroll_period_start(v_period), 'YYYY-MM');
    v_statutory := v_changed && ARRAY['sss', 'philhealth', 'pagibig', 'withholding_tax'];
    v_tax := v_changed && ARRAY['gross_pay', 'basic_salary', 'basic_earned', 'sss', 'philhealth', 'pagibig', 'withholding_tax', 'year_end_tax'];

    IF v_run.id IS NOT NULL THEN
      INSERT INTO public.payroll_review_flags (override_id, kind, ref_id, employee_id, branch_id, pay_period, tax_year, message)
      VALUES (v_override, 'payroll_run', v_run.id, v_employee, v_new.branch_id, v_period, v_year,
        format('The approved %s run''s totals predate the override of %s''s payslip (net %s -> %s).',
          v_period, v_new.employee_name, v_old_values ->> 'net_pay', v_new_values ->> 'net_pay'));
    END IF;

    IF v_statutory THEN
      INSERT INTO public.payroll_review_flags (override_id, kind, employee_id, branch_id, pay_period, tax_year, month, message)
      VALUES (v_override, 'remittance', v_employee, v_new.branch_id, v_period, v_year, v_month,
        format('%s''s contributions or withholding tax for %s changed (SSS %s -> %s, PhilHealth %s -> %s, Pag-IBIG %s -> %s, tax %s -> %s). A remittance already filed for %s may differ.',
          v_new.employee_name, v_period,
          v_old_values ->> 'sss', v_new_values ->> 'sss', v_old_values ->> 'philhealth', v_new_values ->> 'philhealth',
          v_old_values ->> 'pagibig', v_new_values ->> 'pagibig', v_old_values ->> 'withholding_tax', v_new_values ->> 'withholding_tax', v_month));
    END IF;

    IF v_tax THEN
      FOR r IN
        SELECT e.id, e.kind, e.generated_at FROM public.payroll_bir_exports e
         WHERE e.tax_year = v_year
           AND (e.employee_id = v_employee OR e.rows @> jsonb_build_array(jsonb_build_object('employee_id', v_employee::TEXT)))
      LOOP
        INSERT INTO public.payroll_review_flags (override_id, kind, ref_id, employee_id, branch_id, pay_period, tax_year, message)
        VALUES (v_override, CASE WHEN r.kind = 'alphalist' THEN 'bir_alphalist' ELSE 'bir_2316' END, r.id, v_employee, v_new.branch_id, v_period, v_year,
          format('The %s %s generated on %s includes %s''s %s payslip from before the override; generate it again.',
            v_year, CASE WHEN r.kind = 'alphalist' THEN 'alphalist' ELSE 'BIR 2316' END,
            to_char(r.generated_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD'), v_new.employee_name, v_period));
      END LOOP;

      FOR r IN SELECT a.id FROM public.payroll_tax_annualizations a WHERE a.employee_id = v_employee AND a.tax_year = v_year LOOP
        INSERT INTO public.payroll_review_flags (override_id, kind, ref_id, employee_id, branch_id, pay_period, tax_year, message)
        VALUES (v_override, 'tax_annualization', r.id, v_employee, v_new.branch_id, v_period, v_year,
          format('%s''s %s year-end annualization used the %s payslip from before the override; run it again.', v_new.employee_name, v_year, v_period));
      END LOOP;
    END IF;

    IF v_changed && ARRAY['basic_earned'] THEN
      FOR r IN SELECT t.id FROM public.payroll_thirteenth_month t WHERE t.employee_id = v_employee AND t.year = v_year LOOP
        INSERT INTO public.payroll_review_flags (override_id, kind, ref_id, employee_id, branch_id, pay_period, tax_year, message)
        VALUES (v_override, 'thirteenth_month', r.id, v_employee, v_new.branch_id, v_period, v_year,
          format('%s''s %s 13th month used basic pay earned of %s for %s; after the override it is %s.',
            v_new.employee_name, v_year, v_old_values ->> 'basic_earned', v_period, v_new_values ->> 'basic_earned'));
      END LOOP;
    END IF;
  END IF;

  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'ref_id', f.ref_id, 'message', f.message) ORDER BY f.kind), '[]'::JSONB)
    INTO v_flag_count, v_flags
    FROM public.payroll_review_flags f WHERE f.override_id = v_override;

  IF v_flag_count > 0 THEN
    -- The branch's Accountants own the remittance and BIR records; HR approved the run.
    INSERT INTO public.notifications (recipient_id, kind, title, body, link_page, run_id)
    SELECT p.id, 'payroll_review',
      format('Review needed: payslip override for %s', v_new.employee_name),
      format('The Super Admin overrode the %s payslip (net %s -> %s). %s record(s) that used the old figures need review.',
        v_period, v_old_values ->> 'net_pay', v_new_values ->> 'net_pay', v_flag_count),
      CASE WHEN lower(p.role::TEXT) = 'hr' THEN 'hr-payroll-approval' ELSE 'ac-reports' END,
      v_run.id
      FROM public.profiles p
     WHERE NOT COALESCE(p.archived, FALSE)
       AND ((lower(p.role::TEXT) = 'accountant' AND p.branch_id = v_new.branch_id)
         OR (lower(p.role::TEXT) = 'hr' AND v_run.id IS NOT NULL));
  END IF;

  RETURN jsonb_build_object(
    'override_id', v_override,
    'entry_id', v_new.id,
    'old_payslip_no', v_old.payslip_no,
    'payslip_no', v_new.payslip_no,
    'run_status', v_run.status,
    'old_values', v_old_values,
    'new_values', v_new_values,
    'changed_fields', to_jsonb(v_changed),
    'review_flags', v_flags
  );
END;
$function$;

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

-- Runs as the screens read them: which run of the period, and how many
-- employees the current snapshot left out.
CREATE OR REPLACE VIEW public.payroll_run_summaries AS
 SELECT r.id,
    r.branch_id,
    b.name AS branch_name,
    r.period_label,
    r.period_start,
    r.period_end,
    r.cutoff_type,
    r.status,
    r.submission_no,
    r.processed_by,
    r.processed_by_name,
    r.submitted_by,
    r.submitted_by_name,
    r.submitted_at,
    r.reviewed_by,
    r.reviewed_by_name,
    r.reviewed_at,
    r.remarks,
    r.total_employees,
    r.total_gross,
    r.total_deductions,
    r.total_net,
    r.created_at,
    r.updated_at,
    ( SELECT count(*) AS count
           FROM payroll_run_items i
          WHERE ((i.run_id = r.id) AND (i.submission_no = r.submission_no) AND (cardinality(i.flags) > 0))) AS flagged_employees,
    r.run_no,
    ( SELECT count(*) AS count
           FROM payroll_run_exclusions x
          WHERE ((x.run_id = r.id) AND (x.submission_no = r.submission_no))) AS excluded_employees
   FROM (payroll_runs r
     LEFT JOIN branches b ON ((b.id = r.branch_id)));

REVOKE ALL ON FUNCTION public.submit_payroll_run(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_payroll_run(uuid, uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.payroll_run_exclusions_guard() FROM PUBLIC, anon, authenticated;
