-- Rollback of 20261126080000_perfect_attendance_automatic.sql (Perfect Attendance paid automatically).
-- Back to HR approving each one. Refuses (changes nothing) once HR has undone one after processing
-- (an adjustment points to it): that adjustment is a stored pay item and is never deleted.
-- Afterwards payroll pays Perfect Attendance only once HR approves (the app reads no auto setting).
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payroll_monthly_incentives WHERE undoes_recommendation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'An undo adjustment exists: rolling back would lose its link. Nothing was changed.';
  END IF;
END $$;

DELETE FROM public.system_config WHERE section = 'automation' AND key = 'perfect_attendance_auto_from';
DROP FUNCTION IF EXISTS public.incentive_recommendation_undo(UUID, UUID, TEXT);

-- The ledger view as in 20261124120000 (without the undo branch).
CREATE OR REPLACE VIEW public.payroll_exempt_benefits_paid
WITH (security_invoker = true) AS
  SELECT t.employee_id, t.year AS tax_year, 'thirteenth_month'::TEXT AS kind, t.amount, t.processed_at::DATE AS paid_on
  FROM public.payroll_thirteenth_month t
  UNION ALL
  SELECT l.employee_id, EXTRACT(YEAR FROM l.date_granted)::INTEGER, 'subsidy_advance', l.principal, l.date_granted
  FROM public.payroll_loans l JOIN public.payroll_subsidy_balances b ON b.id = l.subsidy_balance_id
  WHERE l.loan_type = 'subsidy_advance' AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT b.employee_id, EXTRACT(YEAR FROM b.paid_out_on)::INTEGER, 'subsidy_payout', b.paid_out, b.paid_out_on
  FROM public.payroll_subsidy_balances b
  WHERE b.paid_out > 0 AND b.paid_out_on IS NOT NULL AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT a.employee_id, EXTRACT(YEAR FROM a.applied_at)::INTEGER, 'subsidy_adjustment', a.amount, a.applied_at::DATE
  FROM public.payroll_subsidy_adjustments a JOIN public.payroll_subsidy_balances b ON b.id = a.subsidy_balance_id
  WHERE a.status = 'applied' AND b.tax_treatment = 'other_benefit'
  UNION ALL
  SELECT e.employee_id, EXTRACT(YEAR FROM x.period_end)::INTEGER, 'bonus', x.amount, x.period_end
  FROM public.payroll_entries e
  CROSS JOIN LATERAL (
    SELECT NULLIF(e.payroll -> 'audit' -> 'period' ->> 'end_key', '')::DATE AS period_end,
           NULLIF(e.payroll -> 'audit' -> 'period' ->> 'start_key', '')::DATE AS period_start,
           COALESCE((e.payroll -> 'totals' ->> 'early_bird_winner_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'perfect_attendance_incentive')::NUMERIC, 0)
             + COALESCE((e.payroll -> 'totals' ->> 'bonus_items')::NUMERIC, 0) AS amount
  ) x
  WHERE e.status = 'paid' AND x.period_end IS NOT NULL AND x.period_start >= DATE '2026-10-01' AND x.amount > 0;
REVOKE ALL ON public.payroll_exempt_benefits_paid FROM anon, authenticated;

DROP INDEX IF EXISTS public.payroll_monthly_incentives_undoes_idx;
ALTER TABLE public.payroll_monthly_incentives DROP COLUMN IF EXISTS undoes_recommendation_id;

-- On live, also remove the history row:
-- DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261126080000';
COMMIT;
