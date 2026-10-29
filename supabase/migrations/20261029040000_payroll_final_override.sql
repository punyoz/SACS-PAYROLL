-- Final-payslip override: the Super Admin's emergency recovery path
-- (decision 2026-10-29). Backend only, no screen.
--
-- Since role separation (20261020010000) no role could use override_final,
-- and the run lock (payroll_run_lock_guard) refused any change to a Pending
-- or Approved run, so it could not correct the payslips it exists for.
-- This migration gives it exactly one role and one path:
--
--   1. Module payroll_override: Super Admin only (read + update). Every
--      other role: none. Nothing else changes for the Super Admin: it still
--      has no process_payroll, so it cannot generate, reprocess or submit.
--   2. public.payroll_override_final(): the only way the override writes. In
--      one transaction it checks the actor (an active Super Admin), the
--      reason (at least 10 characters), the payslip (Final) and its run
--      (Approved by HR; a payslip still in the Accountant -> HR flow is
--      refused, it is corrected there), archives the old payroll record,
--      writes the recomputed payslip through payroll_commit_entries, and
--      records the override and its downstream review flags. Any failure
--      undoes all of it.
--   3. public.payroll_final_overrides: one append-only row per override
--      (who, which payslip / employee / period, old and new values, reason,
--      when), separate from the ordinary payroll logs.
--   4. public.payroll_review_flags: records that relied on the old figures
--      and now need a person to look at them. They are flagged, never
--      changed: the approved run's totals, the month's remittance (when a
--      contribution or the withholding tax changed), generated BIR 2316 /
--      alphalist files of the year, the employee's year-end annualization
--      and 13th month. The branch's Accountants (and HR for the run) are
--      notified.
--
-- Additive: one permission module, two tables, two functions. No existing
-- row or function is changed.

-- ── 1. Permission module ────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'payroll_override', 'all',  false, true,  true,  false),
  ('admin',       'payroll_override', 'none', false, false, false, false),
  ('hr',          'payroll_override', 'none', false, false, false, false),
  ('accountant',  'payroll_override', 'none', false, false, false, false),
  ('employee',    'payroll_override', 'none', false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = NOW();

-- ── 2. The override log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_final_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL,
  employee_id     UUID NOT NULL REFERENCES public.profiles(id),
  employee_name   TEXT,
  branch_id       UUID REFERENCES public.branches(id),
  pay_period      TEXT NOT NULL,
  run_id          UUID REFERENCES public.payroll_runs(id),
  -- The run's status when overridden ('approved'; NULL before Payroll Approval existed).
  run_status      TEXT,
  reason          TEXT NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  old_payslip_no  TEXT,
  new_payslip_no  TEXT,
  -- { gross_pay, total_deductions, net_pay, basic_salary, basic_earned, sss, philhealth, pagibig, withholding_tax, year_end_tax }
  old_values      JSONB NOT NULL,
  new_values      JSONB NOT NULL,
  -- The keys of old_values whose value changed.
  changed_fields  TEXT[] NOT NULL DEFAULT '{}',
  actor_id        UUID NOT NULL REFERENCES public.profiles(id),
  actor_name      TEXT,
  actor_role      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_final_overrides_employee_idx ON public.payroll_final_overrides (employee_id, pay_period);
CREATE INDEX IF NOT EXISTS payroll_final_overrides_created_idx ON public.payroll_final_overrides (created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_final_overrides_actor_idx ON public.payroll_final_overrides (actor_id);
CREATE INDEX IF NOT EXISTS payroll_final_overrides_branch_idx ON public.payroll_final_overrides (branch_id);
CREATE INDEX IF NOT EXISTS payroll_final_overrides_run_idx ON public.payroll_final_overrides (run_id);

-- ── 3. Review flags ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_review_flags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  override_id      UUID NOT NULL REFERENCES public.payroll_final_overrides(id),
  kind             TEXT NOT NULL CHECK (kind IN ('payroll_run', 'remittance', 'bir_2316', 'bir_alphalist', 'tax_annualization', 'thirteenth_month')),
  -- The flagged record (payroll_runs / payroll_bir_exports / payroll_tax_annualizations /
  -- payroll_thirteenth_month id); NULL for the remittance, which is not stored.
  ref_id           UUID,
  employee_id      UUID NOT NULL REFERENCES public.profiles(id),
  branch_id        UUID REFERENCES public.branches(id),
  pay_period       TEXT NOT NULL,
  tax_year         INTEGER,
  -- 'YYYY-MM' of the remittance month.
  month            TEXT,
  message          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed')),
  reviewed_by      UUID REFERENCES public.profiles(id),
  reviewed_by_name TEXT,
  reviewed_at      TIMESTAMPTZ,
  review_note      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_review_flags_reviewed_chk CHECK (status = 'open' OR (reviewed_at IS NOT NULL AND char_length(btrim(COALESCE(review_note, ''))) >= 5))
);

CREATE INDEX IF NOT EXISTS payroll_review_flags_open_idx ON public.payroll_review_flags (branch_id, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS payroll_review_flags_override_idx ON public.payroll_review_flags (override_id);
CREATE INDEX IF NOT EXISTS payroll_review_flags_employee_idx ON public.payroll_review_flags (employee_id);
CREATE INDEX IF NOT EXISTS payroll_review_flags_reviewed_by_idx ON public.payroll_review_flags (reviewed_by);

-- Server only (the API uses the service role after its own permission check).
ALTER TABLE public.payroll_final_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_final_overrides FROM anon, authenticated;
DROP POLICY IF EXISTS payroll_final_overrides_no_client_access ON public.payroll_final_overrides;
CREATE POLICY payroll_final_overrides_no_client_access ON public.payroll_final_overrides
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

ALTER TABLE public.payroll_review_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_review_flags FROM anon, authenticated;
DROP POLICY IF EXISTS payroll_review_flags_no_client_access ON public.payroll_review_flags;
CREATE POLICY payroll_review_flags_no_client_access ON public.payroll_review_flags
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

-- The override log is never changed or removed; a flag only changes from
-- open to reviewed (with who, when and a note), and is never removed.
CREATE OR REPLACE FUNCTION public.payroll_final_overrides_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'forbidden: a payslip override record is kept as it was written.' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS payroll_final_overrides_append_only ON public.payroll_final_overrides;
CREATE TRIGGER payroll_final_overrides_append_only BEFORE UPDATE OR DELETE ON public.payroll_final_overrides
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_overrides_append_only();

CREATE OR REPLACE FUNCTION public.payroll_review_flags_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'forbidden: a review flag is never removed; mark it reviewed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' OR NEW.status <> 'reviewed'
     OR (to_jsonb(NEW) - ARRAY['status', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'review_note'])
        <> (to_jsonb(OLD) - ARRAY['status', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'review_note']) THEN
    RAISE EXCEPTION 'forbidden: an open review flag can only be marked reviewed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_review_flags_guard ON public.payroll_review_flags;
CREATE TRIGGER payroll_review_flags_guard BEFORE UPDATE OR DELETE ON public.payroll_review_flags
  FOR EACH ROW EXECUTE FUNCTION public.payroll_review_flags_guard();

-- ── 4. The override ─────────────────────────────────────────────────────

-- The figures an override compares, from a payroll_entries row.
CREATE OR REPLACE FUNCTION public.payroll_override_values(p_entry public.payroll_entries)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'payslip_no',       p_entry.payslip_no,
    'gross_pay',        COALESCE(p_entry.gross_pay, 0),
    'total_deductions', COALESCE(p_entry.total_deductions, 0),
    'net_pay',          COALESCE(p_entry.net_pay, 0),
    'basic_salary',     COALESCE(p_entry.basic_salary, 0),
    'basic_earned',     COALESCE(public.payroll_json_amount(p_entry.payroll -> 'basic_earned'), 0),
    'sss',              COALESCE(p_entry.sss, 0),
    'philhealth',       COALESCE(p_entry.philhealth, 0),
    'pagibig',          COALESCE(p_entry.pagibig, 0),
    'withholding_tax',  COALESCE(p_entry.withholding_tax, 0),
    'year_end_tax',     COALESCE(public.payroll_json_amount(p_entry.payroll #> '{year_end_tax,amount}'), 0)
  );
$$;

CREATE OR REPLACE FUNCTION public.payroll_override_final(p_actor UUID, p_item JSONB, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  SELECT * INTO v_run FROM public.payroll_runs WHERE branch_id = v_old.branch_id AND period_label = v_period;
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
$$;

REVOKE ALL ON FUNCTION public.payroll_override_values(public.payroll_entries) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_override_final(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_final_overrides_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_review_flags_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_override_values(public.payroll_entries) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_override_final(UUID, JSONB, TEXT) TO service_role;
