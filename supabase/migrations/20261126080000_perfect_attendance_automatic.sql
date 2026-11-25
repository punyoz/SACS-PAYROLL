-- ═══════════════════════════════════════════════════════════════════════════
-- Perfect Attendance paid automatically (owner decision 2026-11-25).
--
-- From the pay period in automation.perfect_attendance_auto_from, Perfect
-- Attendance is computed from attendance on BOTH halves and paid without
-- waiting for HR: payroll records it as approved by "System (attendance)"
-- (src/lib/payroll/incentive-recommendations.js). HR sees it and can UNDO it
-- with a reason (incentive_recommendation_undo below):
--   * payslip not processed yet  -> simply not paid when it is computed;
--   * payslip already processed  -> that payslip stays as it is; the next
--     payslip takes the amount back as a labelled, approved adjustment
--     ("Perfect attendance undone (period)", non-taxable, like the bonus).
-- The shared ₱90,000 "13th month and other benefits" ceiling: Perfect
-- Attendance already counts there; an undone amount now counts back (the
-- ledger view below subtracts it). Early Bird keeps HR's approval.
-- Periods before the setting keep the current rule (HR approves).
-- Additive: one setting, one nullable column, one function, the view replaced
-- with one more UNION branch. No stored payslip or incentive is changed.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.system_config (section, key, value, updated_by)
VALUES ('automation', 'perfect_attendance_auto_from', '2026-12-01', 'System (owner decision 2026-11-25)')
ON CONFLICT (section, key) DO NOTHING;

-- An adjustment that takes back an undone Perfect Attendance points to it.
ALTER TABLE public.payroll_monthly_incentives
  ADD COLUMN IF NOT EXISTS undoes_recommendation_id UUID REFERENCES public.incentive_recommendations(id);
CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_undoes_idx ON public.payroll_monthly_incentives (undoes_recommendation_id)
  WHERE undoes_recommendation_id IS NOT NULL;

-- HR undoes an automatic (or approved) Perfect Attendance, with a reason. Never their own.
CREATE OR REPLACE FUNCTION public.incentive_recommendation_undo(p_actor UUID, p_id UUID, p_note TEXT)
RETURNS TABLE (id UUID, employee_id UUID, status TEXT, adjustment_id UUID, adjustment_amount NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_actor RECORD;
  v_row public.incentive_recommendations%ROWTYPE;
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_paid NUMERIC := 0;
  v_adj UUID;
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
BEGIN
  SELECT p.id, p.role::TEXT AS role, p.full_name, COALESCE(p.archived, false) AS archived INTO v_actor FROM public.profiles p WHERE p.id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role <> 'hr' OR v_actor.archived THEN
    RAISE EXCEPTION 'forbidden: only HR undoes an incentive.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(COALESCE(v_note, '')) < 5 THEN
    RAISE EXCEPTION 'invalid: give the reason for undoing it (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_row FROM public.incentive_recommendations r WHERE r.id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'not_found: no such incentive.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_row.employee_id = p_actor THEN
    RAISE EXCEPTION 'forbidden: your own incentive is decided by another HR officer.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_row.kind <> 'perfect_attendance' THEN
    RAISE EXCEPTION 'invalid: only Perfect Attendance is undone this way.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'already_decided: it is %, nothing to undo.', v_row.status USING ERRCODE = 'unique_violation';
  END IF;

  -- Already on a processed payslip of its pay period? Then the next payslip takes it back.
  SELECT COALESCE(MAX((e.payroll -> 'totals' ->> 'perfect_attendance_incentive')::NUMERIC), 0) INTO v_paid
  FROM public.payroll_entries e
  WHERE e.employee_id = v_row.employee_id AND e.pay_period = v_row.pay_period AND e.status <> 'draft';

  IF v_paid > 0 THEN
    INSERT INTO public.payroll_monthly_incentives (employee_id, branch_id, item_date, kind, description, amount, reason, non_taxable,
      approval_status, created_by, created_by_name, decided_by, decided_by_name, decided_at, decision_note, undoes_recommendation_id)
    VALUES (v_row.employee_id, v_row.branch_id, v_today, 'adjustment', left('Perfect attendance undone (' || v_row.pay_period || ')', 200),
      -LEAST(v_paid, v_row.amount), left(v_note, 500), TRUE,
      'approved', v_actor.id, v_actor.full_name, v_actor.id, v_actor.full_name, NOW(), 'Undo of the automatic Perfect Attendance', v_row.id)
    RETURNING public.payroll_monthly_incentives.id INTO v_adj;
  END IF;

  RETURN QUERY UPDATE public.incentive_recommendations r
    SET status = 'rejected', decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(),
        decision_note = left('Undone by HR: ' || v_note, 500), updated_at = NOW()
    WHERE r.id = p_id
    RETURNING r.id, r.employee_id, r.status, v_adj, CASE WHEN v_adj IS NULL THEN 0 ELSE -LEAST(v_paid, v_row.amount) END;
END;
$$;
REVOKE ALL ON FUNCTION public.incentive_recommendation_undo(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incentive_recommendation_undo(UUID, UUID, TEXT) TO service_role;

-- The yearly "13th month and other benefits" ledger (as in 20261124120000), plus: an undone Perfect
-- Attendance taken back by an approved adjustment counts back (a negative bonus row).
CREATE OR REPLACE VIEW public.payroll_exempt_benefits_paid
WITH (security_invoker = true) AS
  SELECT t.employee_id, t.year AS tax_year, 'thirteenth_month'::TEXT AS kind,
         t.amount, t.processed_at::DATE AS paid_on
  FROM public.payroll_thirteenth_month t
  UNION ALL
  SELECT l.employee_id, EXTRACT(YEAR FROM l.date_granted)::INTEGER, 'subsidy_advance',
         l.principal, l.date_granted
  FROM public.payroll_loans l
  JOIN public.payroll_subsidy_balances b ON b.id = l.subsidy_balance_id
  WHERE l.loan_type = 'subsidy_advance' AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT b.employee_id, EXTRACT(YEAR FROM b.paid_out_on)::INTEGER, 'subsidy_payout',
         b.paid_out, b.paid_out_on
  FROM public.payroll_subsidy_balances b
  WHERE b.paid_out > 0 AND b.paid_out_on IS NOT NULL AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT a.employee_id, EXTRACT(YEAR FROM a.applied_at)::INTEGER, 'subsidy_adjustment',
         a.amount, a.applied_at::DATE
  FROM public.payroll_subsidy_adjustments a
  JOIN public.payroll_subsidy_balances b ON b.id = a.subsidy_balance_id
  WHERE a.status = 'applied' AND b.tax_treatment = 'other_benefit'
  UNION ALL
  -- Early Bird and Perfect Attendance bonuses, and bonus items (2026-11-23), of Final semi-monthly payslips.
  SELECT e.employee_id, EXTRACT(YEAR FROM x.period_end)::INTEGER, 'bonus',
         x.amount, x.period_end
  FROM public.payroll_entries e
  CROSS JOIN LATERAL (
    SELECT NULLIF(e.payroll -> 'audit' -> 'period' ->> 'end_key', '')::DATE AS period_end,
           NULLIF(e.payroll -> 'audit' -> 'period' ->> 'start_key', '')::DATE AS period_start,
           COALESCE((e.payroll -> 'totals' ->> 'early_bird_winner_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'perfect_attendance_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'bonus_items')::NUMERIC, 0) AS amount
  ) x
  WHERE e.status = 'paid' AND x.period_end IS NOT NULL AND x.period_start >= DATE '2026-10-01' AND x.amount > 0
  UNION ALL
  -- 2026-11-25: an undone Perfect Attendance taken back (negative), so the ceiling counts what was really kept.
  SELECT i.employee_id, EXTRACT(YEAR FROM i.item_date)::INTEGER, 'bonus', i.amount, i.item_date
  FROM public.payroll_monthly_incentives i
  WHERE i.undoes_recommendation_id IS NOT NULL AND i.approval_status = 'approved' AND NOT i.archived;

REVOKE ALL ON public.payroll_exempt_benefits_paid FROM anon, authenticated;
