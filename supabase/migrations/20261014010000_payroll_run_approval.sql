-- ═══════════════════════════════════════════════════════════════════════════
-- Payroll Approval: one run per branch per pay period, approved by HR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20261013010000_employee_schedules_cutoffs_early_bird.sql.
--
-- Workflow
--   1. The Accountant processes each branch's payslips for a cutoff
--      (payroll_entries, Final = status 'paid', as today).
--   2. "Submit for HR Approval": submit_payroll_run() snapshots every
--      employee's computation into payroll_run_items and sets the run Pending.
--      From then on the branch's payroll for that period cannot change.
--   3. HR approves (approve_payroll_run) or rejects with a reason
--      (reject_payroll_run). Approved: locked for good, the Early Bird winner
--      of the period is locked, and employees see their payslips. Rejected:
--      nothing is cleared; the Accountant corrects and resubmits.
--
--   Statuses   draft → pending → approved
--                       pending → rejected → pending (resubmit)
--   Anything else is refused by the database, whoever asks.
--
-- What is REUSED, not duplicated
--   payroll_entries   the processed payslips (one per employee and period;
--                     status 'paid' = Final). A run groups them by
--                     payroll_entries.branch_id + pay_period; this adds
--                     payroll_entries.run_id, and approval fills the
--                     existing, until now unused, approved_by / approved_at.
--   payroll_records   unchanged; locked with the run (no new payslip numbers
--                     or archiving for a Pending / Approved run).
--   early_bird_winners (20261013010000) now locks when the period's first run
--                     is approved, instead of on the first Final payslip.
--   audit_logs        every action writes a row (actor_id / actor_role / actor_name).
--   private.has_permission / can_reach_branch / current_role_name  the RLS helpers.
--   The payroll_state enum's pending_approval / approved / rejected values are
--   per-payslip and stay unused: approval is per run, in payroll_runs.status.
--
-- NEW tables: payroll_runs, payroll_run_items, payroll_approval_history,
-- notifications (there was none). New view: payroll_run_summaries.
--
-- Who may do what is enforced twice: by the API routes (src/lib/rbac/
-- permissions.js, module payroll_run_approval) and here, in the functions
-- and triggers, which the service role cannot get around either. The RLS
-- policies are the third layer for any direct client; like every other
-- table since 20261012020000, `authenticated` holds no table grant, so the
-- browser never reads these tables directly.
--
-- Payslips of pay periods from October 1, 2026 are shown to employees only
-- once their branch's run is Approved (payroll_period_requires_approval).
--
-- Safe to run more than once.

-- ── 1. Period helpers ─────────────────────────────────────────────────────

-- From this period on, a payslip reaches the employee only after HR approval.
CREATE OR REPLACE FUNCTION public.payroll_approval_effective()
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$ SELECT DATE '2026-10-01' $$;

-- "October 1-15, 2026" -> 2026-10-01; "October 16-31, 2026" -> 2026-10-16; NULL otherwise.
CREATE OR REPLACE FUNCTION public.payroll_period_start(p_label TEXT)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_match TEXT[];
BEGIN
  v_match := regexp_match(COALESCE(p_label, ''), '^\s*([A-Za-z]+)\s+(1|16)-\d{1,2},\s*(\d{4})\s*$');
  IF v_match IS NULL THEN RETURN NULL; END IF;
  RETURN to_date(v_match[1] || ' ' || v_match[2] || ' ' || v_match[3], 'FMMonth FMDD YYYY');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 2026-10-16 -> "October 16-31, 2026" (the label payroll_entries.pay_period stores).
CREATE OR REPLACE FUNCTION public.payroll_period_label(p_start DATE)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT to_char(p_start, 'FMMonth') || ' ' || EXTRACT(DAY FROM p_start)::INTEGER || '-'
    || CASE WHEN EXTRACT(DAY FROM p_start) = 1 THEN 15
            ELSE EXTRACT(DAY FROM (date_trunc('month', p_start) + INTERVAL '1 month - 1 day'))::INTEGER END
    || ', ' || EXTRACT(YEAR FROM p_start)::INTEGER;
$$;

CREATE OR REPLACE FUNCTION public.payroll_period_requires_approval(p_label TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(public.payroll_period_start(p_label) >= public.payroll_approval_effective(), FALSE);
$$;

-- ── 2. Tables ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            UUID NOT NULL REFERENCES public.branches(id),
  period_label         TEXT NOT NULL,                     -- "October 1-15, 2026"
  period_start         DATE NOT NULL,
  period_end           DATE NOT NULL,
  cutoff_type          TEXT NOT NULL CHECK (cutoff_type IN ('first', 'second')),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  submission_no        INTEGER NOT NULL DEFAULT 0,        -- the snapshot HR reads
  processed_by         UUID REFERENCES public.profiles(id),
  processed_by_name    TEXT,
  submitted_by         UUID REFERENCES public.profiles(id),
  submitted_by_name    TEXT,
  submitted_at         TIMESTAMPTZ,
  reviewed_by          UUID REFERENCES public.profiles(id),
  reviewed_by_name     TEXT,
  reviewed_at          TIMESTAMPTZ,
  remarks              TEXT,                              -- HR's reason (rejected) or note (approved)
  total_employees      INTEGER NOT NULL DEFAULT 0,
  total_gross          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_deductions     NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_net            NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_runs_one_per_branch_period UNIQUE (branch_id, period_start),
  CONSTRAINT payroll_runs_period_chk CHECK (EXTRACT(DAY FROM period_start) IN (1, 16) AND period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS payroll_runs_status_idx ON public.payroll_runs (status, period_start DESC);
CREATE INDEX IF NOT EXISTS payroll_runs_branch_idx ON public.payroll_runs (branch_id, period_start DESC);
CREATE INDEX IF NOT EXISTS payroll_runs_period_idx ON public.payroll_runs (period_label);

-- One row per employee per submission. A resubmission adds rows with the
-- next submission_no; earlier ones stay, so what HR saw each time is kept.
CREATE TABLE IF NOT EXISTS public.payroll_run_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES public.payroll_runs(id),
  submission_no         INTEGER NOT NULL,
  entry_id              UUID NOT NULL REFERENCES public.payroll_entries(id),
  employee_id           UUID NOT NULL REFERENCES public.profiles(id),
  employee_name         TEXT NOT NULL,
  employee_code         TEXT,
  employee_level        TEXT,
  schedule_name         TEXT,
  payslip_no            TEXT,
  processed_by          UUID,
  basic_pay             NUMERIC(14, 2) NOT NULL DEFAULT 0,
  gross_pay             NUMERIC(14, 2) NOT NULL DEFAULT 0,   -- earnings incl. incentives
  total_deductions      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_pay               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  attendance_deduction  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  absence_deduction     NUMERIC(14, 2) NOT NULL DEFAULT 0,
  late_deduction        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  undertime_deduction   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  half_day_deduction    NUMERIC(14, 2) NOT NULL DEFAULT 0,
  leave_without_pay_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0,
  withholding_tax       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sss                   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  philhealth            NUMERIC(14, 2) NOT NULL DEFAULT 0,
  pagibig               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  loans                 NUMERIC(14, 2) NOT NULL DEFAULT 0,
  other_deductions      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  early_bird_incentive  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_incentives      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  days_worked           NUMERIC(6, 2) NOT NULL DEFAULT 0,
  absent_days           NUMERIC(6, 2) NOT NULL DEFAULT 0,
  late_days             NUMERIC(6, 2) NOT NULL DEFAULT 0,
  late_minutes          NUMERIC(8, 2) NOT NULL DEFAULT 0,
  undertime_minutes     NUMERIC(8, 2) NOT NULL DEFAULT 0,
  half_days             NUMERIC(6, 2) NOT NULL DEFAULT 0,
  previous_net_pay      NUMERIC(14, 2),
  flags                 TEXT[] NOT NULL DEFAULT '{}',        -- negative_net · zero_days · large_change
  breakdown             JSONB NOT NULL DEFAULT '{}'::JSONB,  -- every line, how it was computed
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_run_items_one_per_submission UNIQUE (run_id, submission_no, employee_id)
);

CREATE INDEX IF NOT EXISTS payroll_run_items_run_idx ON public.payroll_run_items (run_id, submission_no);
CREATE INDEX IF NOT EXISTS payroll_run_items_employee_idx ON public.payroll_run_items (employee_id);

CREATE TABLE IF NOT EXISTS public.payroll_approval_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID NOT NULL REFERENCES public.payroll_runs(id),
  action       TEXT NOT NULL CHECK (action IN ('submitted', 'resubmitted', 'approved', 'rejected')),
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  actor_id     UUID,
  actor_role   TEXT NOT NULL,
  actor_name   TEXT,
  remarks      TEXT,
  totals       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_approval_history_run_idx ON public.payroll_approval_history (run_id, created_at);

CREATE TABLE IF NOT EXISTS public.notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID NOT NULL REFERENCES public.profiles(id),
  kind          TEXT NOT NULL,                 -- payroll_run_submitted · payroll_run_approved · payroll_run_rejected
  title         TEXT NOT NULL,
  body          TEXT,
  link_page     TEXT,                          -- the portal page to open ("hr-payroll-approval", "ac-process")
  run_id        UUID REFERENCES public.payroll_runs(id),
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON public.notifications (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON public.notifications (recipient_id) WHERE read_at IS NULL;

ALTER TABLE public.payroll_entries ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES public.payroll_runs(id);
CREATE INDEX IF NOT EXISTS payroll_entries_run_idx ON public.payroll_entries (run_id);
CREATE INDEX IF NOT EXISTS payroll_entries_branch_period_idx ON public.payroll_entries (branch_id, pay_period);

-- ── 3. Guards (apply to every caller, the service role included) ─────────
-- The approval functions switch on sacs.payroll_run_action for their own
-- transaction; nothing else can.

CREATE OR REPLACE FUNCTION public.payroll_run_action_on()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$ SELECT COALESCE(current_setting('sacs.payroll_run_action', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION public.payroll_runs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A payroll run is never deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NOT public.payroll_run_action_on() THEN
      RAISE EXCEPTION 'A payroll run starts as Draft.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT public.payroll_run_action_on() THEN
    RAISE EXCEPTION 'A payroll run changes only through submit / approve / reject.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'    AND NEW.status = 'pending')
    OR (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'rejected' AND NEW.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'A payroll run cannot move from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.branch_id <> OLD.branch_id OR NEW.period_start <> OLD.period_start THEN
    RAISE EXCEPTION 'A payroll run''s branch and period never change.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_runs_guard ON public.payroll_runs;
CREATE TRIGGER payroll_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_guard();

-- Snapshots and history are written once, by the functions, and never changed.
CREATE OR REPLACE FUNCTION public.payroll_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are never changed or deleted.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.payroll_run_action_on() THEN
    RAISE EXCEPTION '% rows are written only by submit / approve / reject.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_run_items_guard ON public.payroll_run_items;
CREATE TRIGGER payroll_run_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_run_items
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only_guard();

DROP TRIGGER IF EXISTS payroll_approval_history_guard ON public.payroll_approval_history;
CREATE TRIGGER payroll_approval_history_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_approval_history
  FOR EACH ROW EXECUTE FUNCTION public.payroll_append_only_guard();

-- The run a payslip belongs to: its branch and pay period.
CREATE OR REPLACE FUNCTION public.payroll_run_status_for(p_branch UUID, p_label TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT r.status FROM public.payroll_runs r
  WHERE r.branch_id = p_branch AND r.period_label = p_label
  LIMIT 1;
$$;

-- No payslip of a Pending or Approved run is created, changed, reprocessed or
-- removed (payroll_entries and payroll_records). Named to fire after the
-- *_stamp_branch triggers, which fill branch_id on insert.
CREATE OR REPLACE FUNCTION public.payroll_run_lock_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_branch UUID;
  v_label TEXT;
  v_status TEXT;
BEGIN
  IF public.payroll_run_action_on() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'payroll_entries' THEN
    v_branch := COALESCE(NEW.branch_id, OLD.branch_id);
    v_label := COALESCE(NEW.pay_period, OLD.pay_period);
  ELSE
    v_branch := COALESCE(NEW.branch_id, OLD.branch_id);
    v_label := COALESCE(NEW.period_label, OLD.period_label);
  END IF;
  v_status := public.payroll_run_status_for(v_branch, v_label);
  IF v_status IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'payroll_run_locked: the % payroll of this branch is % and cannot be changed.',
      v_label, CASE v_status WHEN 'pending' THEN 'waiting for HR approval' ELSE 'approved' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS payroll_entries_zz_run_lock ON public.payroll_entries;
CREATE TRIGGER payroll_entries_zz_run_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_lock_guard();

DROP TRIGGER IF EXISTS payroll_records_zz_run_lock ON public.payroll_records;
CREATE TRIGGER payroll_records_zz_run_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_records
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_lock_guard();

-- The Early Bird winner now locks on the first approved run of the period
-- (approve_payroll_run), not on the first Final payslip: while every run is
-- still Draft or Rejected, payslips may be reprocessed and the winner with them.
DROP TRIGGER IF EXISTS payroll_entries_lock_early_bird ON public.payroll_entries;

-- ── 4. Writing history, audit and notifications ───────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_run_actor(p_actor UUID)
RETURNS TABLE (id UUID, role TEXT, branch_id UUID, full_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, lower(p.role::TEXT), p.branch_id, COALESCE(NULLIF(p.full_name, ''), p.email)
  FROM public.profiles p
  WHERE p.id = p_actor AND COALESCE(p.archived, FALSE) = FALSE;
$$;

CREATE OR REPLACE FUNCTION public.payroll_run_record(
  p_run public.payroll_runs, p_action TEXT, p_from TEXT,
  p_actor_id UUID, p_actor_role TEXT, p_actor_name TEXT, p_remarks TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch TEXT;
  v_totals JSONB;
  v_role_label TEXT := CASE p_actor_role WHEN 'hr' THEN 'HR' WHEN 'super_admin' THEN 'Super Admin' WHEN 'accountant' THEN 'Accountant' ELSE p_actor_role END;
BEGIN
  SELECT name INTO v_branch FROM public.branches WHERE id = p_run.branch_id;
  v_totals := jsonb_build_object('employees', p_run.total_employees, 'gross', p_run.total_gross,
    'deductions', p_run.total_deductions, 'net', p_run.total_net, 'submission_no', p_run.submission_no);

  INSERT INTO public.payroll_approval_history (run_id, action, from_status, to_status, actor_id, actor_role, actor_name, remarks, totals)
  VALUES (p_run.id, p_action, p_from, p_run.status, p_actor_id, p_actor_role, p_actor_name, p_remarks, v_totals);

  INSERT INTO public.audit_logs (module, action, entity_type, entity_id, description, status, source, metadata, branch_id, is_system_event, actor_id, actor_role, actor_name)
  VALUES (
    'payroll_approval', 'payroll_run_' || p_action, 'payroll_run', p_run.id::TEXT,
    format('%s payroll for %s, %s, %s by %s (%s)%s.',
      initcap(p_action), COALESCE(v_branch, 'branch'), p_run.period_label,
      CASE p_action WHEN 'rejected' THEN 'rejected' WHEN 'approved' THEN 'approved' ELSE 'submitted for HR approval' END,
      p_actor_name, v_role_label, CASE WHEN p_remarks IS NOT NULL THEN ': ' || p_remarks ELSE '' END),
    'success', 'rpc',
    jsonb_build_object('run_id', p_run.id, 'branch_id', p_run.branch_id, 'period', p_run.period_label,
      'from_status', p_from, 'to_status', p_run.status, 'remarks', p_remarks, 'totals', v_totals),
    p_run.branch_id, FALSE, p_actor_id, p_actor_role, p_actor_name
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_run_notify(
  p_recipients UUID[], p_kind TEXT, p_title TEXT, p_body TEXT, p_link TEXT, p_run UUID
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.notifications (recipient_id, kind, title, body, link_page, run_id)
  SELECT DISTINCT r, p_kind, p_title, p_body, p_link, p_run
  FROM unnest(p_recipients) AS r
  WHERE r IS NOT NULL;
$$;

-- ── 5. The approval functions ─────────────────────────────────────────────
-- Called by the API routes with the service role, which passes the signed-in
-- user (p_actor) taken from the session cookie. Each function checks that
-- user's role itself.

-- The run of a branch and period, created as Draft when missing.
CREATE OR REPLACE FUNCTION public.ensure_payroll_run(p_branch UUID, p_period_label TEXT, p_actor UUID)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start DATE := public.payroll_period_start(p_period_label);
  v_actor RECORD;
  v_run public.payroll_runs;
BEGIN
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'invalid_period: % is not a pay period.', p_period_label USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role NOT IN ('accountant', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden: only an Accountant or a Super Admin starts a payroll run.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role = 'accountant' AND v_actor.branch_id IS DISTINCT FROM p_branch THEN
    RAISE EXCEPTION 'forbidden: that is another branch''s payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.payroll_runs (branch_id, period_label, period_start, period_end, cutoff_type, status, processed_by, processed_by_name)
  VALUES (
    p_branch, public.payroll_period_label(v_start), v_start,
    CASE WHEN EXTRACT(DAY FROM v_start) = 1 THEN v_start + 14 ELSE (date_trunc('month', v_start) + INTERVAL '1 month - 1 day')::DATE END,
    CASE WHEN EXTRACT(DAY FROM v_start) = 1 THEN 'first' ELSE 'second' END,
    'draft', v_actor.id, v_actor.full_name
  )
  ON CONFLICT (branch_id, period_start) DO NOTHING;
  SELECT * INTO v_run FROM public.payroll_runs WHERE branch_id = p_branch AND period_start = v_start;
  RETURN v_run;
END;
$$;

-- p_items: one object per processed payslip of the run (built by
-- src/lib/payroll/runs.js shapeRunItem). The function checks that they are
-- exactly the run's Final payslips and that each one's gross, deductions and
-- net equal the payslip's own, then stores them as the snapshot.
CREATE OR REPLACE FUNCTION public.submit_payroll_run(p_run_id UUID, p_actor UUID, p_items JSONB)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF v_actor.id IS NULL OR v_actor.role NOT IN ('accountant', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden: only an Accountant or a Super Admin submits payroll.' USING ERRCODE = 'insufficient_privilege';
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

  SELECT array_agg(e.id ORDER BY e.id) INTO v_expected FROM public.payroll_entries e
  WHERE e.branch_id = v_run.branch_id AND e.pay_period = v_run.period_label AND e.status::TEXT = 'paid';
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
$$;

CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id UUID, p_actor UUID, p_remarks TEXT DEFAULT NULL)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_branch TEXT;
  v_remarks TEXT := NULLIF(btrim(COALESCE(p_remarks, '')), '');
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'hr' THEN
    RAISE EXCEPTION 'forbidden: only HR approves payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
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
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_payroll_run(p_run_id UUID, p_actor UUID, p_remarks TEXT)
RETURNS public.payroll_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs;
  v_actor RECORD;
  v_branch TEXT;
  v_remarks TEXT := NULLIF(btrim(COALESCE(p_remarks, '')), '');
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'not_found: no such payroll run.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_actor FROM public.payroll_run_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role <> 'hr' THEN
    RAISE EXCEPTION 'forbidden: only HR rejects payroll.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_remarks IS NULL OR length(v_remarks) < 5 THEN
    RAISE EXCEPTION 'remarks_required: write the reason for rejecting (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF v_run.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_transition: this run is % and cannot be rejected.', v_run.status USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.payroll_run_action', 'on', true);
  -- Nothing the Accountant did is cleared: the payslips stay, unlocked again.
  UPDATE public.payroll_runs SET status = 'rejected', reviewed_by = v_actor.id, reviewed_by_name = v_actor.full_name,
         reviewed_at = NOW(), remarks = v_remarks
  WHERE id = v_run.id RETURNING * INTO v_run;

  PERFORM public.payroll_run_record(v_run, 'rejected', 'pending', v_actor.id, v_actor.role, v_actor.full_name, v_remarks);
  SELECT name INTO v_branch FROM public.branches WHERE id = v_run.branch_id;
  PERFORM public.payroll_run_notify(ARRAY[v_run.processed_by, v_run.submitted_by], 'payroll_run_rejected',
    format('Payroll rejected: %s, %s', COALESCE(v_branch, 'branch'), v_run.period_label),
    format('Rejected by %s: %s', v_actor.full_name, v_remarks),
    'ac-process', v_run.id);
  RETURN v_run;
END;
$$;

-- ── 6. The HR list: totals per run ─────────────────────────────────────────

CREATE OR REPLACE VIEW public.payroll_run_summaries
WITH (security_invoker = true) AS
SELECT
  r.id, r.branch_id, b.name AS branch_name, r.period_label, r.period_start, r.period_end, r.cutoff_type, r.status,
  r.submission_no, r.processed_by, r.processed_by_name, r.submitted_by, r.submitted_by_name, r.submitted_at,
  r.reviewed_by, r.reviewed_by_name, r.reviewed_at, r.remarks,
  r.total_employees, r.total_gross, r.total_deductions, r.total_net, r.created_at, r.updated_at,
  (SELECT count(*) FROM public.payroll_run_items i
    WHERE i.run_id = r.id AND i.submission_no = r.submission_no AND cardinality(i.flags) > 0) AS flagged_employees
FROM public.payroll_runs r
LEFT JOIN public.branches b ON b.id = r.branch_id;

CREATE OR REPLACE FUNCTION public.payroll_pending_run_count()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT count(*)::INTEGER FROM public.payroll_runs WHERE status = 'pending' $$;

-- ── 7. Access: service role only; RLS as the second line ─────────────────

ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_approval_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payroll_runs, public.payroll_run_items, public.payroll_approval_history, public.notifications
  FROM anon, authenticated;
REVOKE ALL ON public.payroll_run_summaries FROM anon, authenticated;

-- Accountant: own branch's runs; HR and Super Admin: every branch.
DROP POLICY IF EXISTS payroll_runs_read ON public.payroll_runs;
CREATE POLICY payroll_runs_read ON public.payroll_runs FOR SELECT USING (
  private.has_permission('payroll_run_approval', 'read')
  AND (private.current_role_name() IN ('hr', 'super_admin') OR private.can_reach_branch(branch_id))
);
-- Accountant: start a run (Draft) of its own branch.
DROP POLICY IF EXISTS payroll_runs_accountant_insert ON public.payroll_runs;
CREATE POLICY payroll_runs_accountant_insert ON public.payroll_runs FOR INSERT WITH CHECK (
  private.current_role_name() = 'accountant' AND private.can_reach_branch(branch_id) AND status = 'draft'
);
-- Accountant: its Draft / Rejected runs; HR: Pending runs only. (The status
-- itself still moves only through the functions above.)
DROP POLICY IF EXISTS payroll_runs_update ON public.payroll_runs;
CREATE POLICY payroll_runs_update ON public.payroll_runs FOR UPDATE USING (
  (private.current_role_name() = 'accountant' AND private.can_reach_branch(branch_id) AND status IN ('draft', 'rejected'))
  OR (private.current_role_name() = 'hr' AND status = 'pending')
);

DROP POLICY IF EXISTS payroll_run_items_read ON public.payroll_run_items;
CREATE POLICY payroll_run_items_read ON public.payroll_run_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id = run_id
          AND private.has_permission('payroll_run_approval', 'read')
          AND (private.current_role_name() IN ('hr', 'super_admin') OR private.can_reach_branch(r.branch_id)))
);
-- Items are written by submit_payroll_run alone: no insert / update / delete
-- policy for anyone, and the append-only trigger for everyone else.

DROP POLICY IF EXISTS payroll_approval_history_read ON public.payroll_approval_history;
CREATE POLICY payroll_approval_history_read ON public.payroll_approval_history FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id = run_id
          AND private.has_permission('payroll_run_approval', 'read')
          AND (private.current_role_name() IN ('hr', 'super_admin') OR private.can_reach_branch(r.branch_id)))
);

DROP POLICY IF EXISTS notifications_own_read ON public.notifications;
CREATE POLICY notifications_own_read ON public.notifications FOR SELECT USING (recipient_id = auth.uid());
DROP POLICY IF EXISTS notifications_own_mark_read ON public.notifications;
CREATE POLICY notifications_own_mark_read ON public.notifications FOR UPDATE USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- Employees: their own payslip, from October 1, 2026 only once its run is Approved.
DROP POLICY IF EXISTS payroll_entries_own_after_approval ON public.payroll_entries;
CREATE POLICY payroll_entries_own_after_approval ON public.payroll_entries FOR SELECT USING (
  employee_id = auth.uid()
  AND status::TEXT <> 'draft'
  AND (
    NOT public.payroll_period_requires_approval(pay_period)
    OR EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id = payroll_entries.run_id AND r.status = 'approved')
  )
);

REVOKE ALL ON FUNCTION public.ensure_payroll_run(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_payroll_run(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_payroll_run(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_payroll_run(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_pending_run_count() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_run_actor(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_run_record(public.payroll_runs, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_run_notify(UUID[], TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_runs_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_append_only_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_run_lock_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_payroll_run(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_payroll_run(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_payroll_run(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_payroll_run(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_pending_run_count() TO service_role;

-- ── 8. Realtime: the HR list and badge follow payroll_runs live ──────────
-- The server subscribes with the service role (src/app/api/hr/payroll-runs/
-- stream/route.js) and forwards only "a run changed" to the browser, which
-- refetches through the API: no table access is granted to browsers, and
-- the site's Content-Security-Policy (connect-src 'self') stays as it is.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'payroll_runs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_runs;
  END IF;
END $$;

-- ── 9. Permissions (mirrors src/lib/rbac/permissions.js) ───────────────────
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'payroll_run_approval', 'all',    false, true,  false, false),
  ('admin',       'payroll_run_approval', 'none',   false, false, false, false),
  ('hr',          'payroll_run_approval', 'all',    false, true,  true,  false),
  ('accountant',  'payroll_run_approval', 'branch', false, true,  false, false),
  ('employee',    'payroll_run_approval', 'none',   false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();
