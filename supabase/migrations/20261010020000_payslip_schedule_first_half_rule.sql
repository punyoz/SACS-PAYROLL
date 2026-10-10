-- Payslip schedule: a weekend / holiday rule for each half (user's decision,
-- October 10, 2026).
--
--   1st half (the 15th)      next working day by default: Sun Nov 15, 2026
--                            -> Mon Nov 16. The 1st half deducts nothing, so
--                            moving it later changes no attendance.
--   2nd half (month end)     previous working day, unchanged: it stays inside
--                            the month (Sat Oct 31 -> Fri Oct 30).
--
-- payroll_schedule_settings.non_working_day_rule now governs the 2nd half
-- only; first_half_rule governs the 1st half. No settings row = these
-- defaults. Super Admin changes either in the Payslip Schedule card.

ALTER TABLE public.payroll_schedule_settings
  ADD COLUMN IF NOT EXISTS first_half_rule TEXT NOT NULL DEFAULT 'next_working_day';

ALTER TABLE public.payroll_schedule_settings
  DROP CONSTRAINT IF EXISTS payroll_schedule_settings_first_half_rule_check;
ALTER TABLE public.payroll_schedule_settings
  ADD CONSTRAINT payroll_schedule_settings_first_half_rule_check
  CHECK (first_half_rule IN ('same_day', 'previous_working_day', 'next_working_day'));

COMMENT ON COLUMN public.payroll_schedule_settings.first_half_rule IS
  'Weekend / holiday rule for the 1st-half generation day (default next working day).';
COMMENT ON COLUMN public.payroll_schedule_settings.non_working_day_rule IS
  'Weekend / holiday rule for the 2nd-half generation day (default previous working day).';

-- Same columns as before; non_working_day_rule reports the rule used for
-- this period's half.
CREATE OR REPLACE FUNCTION public.payroll_schedule_for(p_period_start DATE)
RETURNS TABLE (
  generation_date      DATE,
  closes_on            DATE,
  window_days          SMALLINT,
  non_working_day_rule TEXT,
  attendance_cutoff    DATE
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH setting AS (
    SELECT x.first_half_day,
           x.second_half_day,
           COALESCE(x.window_days, 5::SMALLINT) AS days,
           CASE WHEN EXTRACT(DAY FROM p_period_start) = 1
                THEN COALESCE(x.first_half_rule, 'next_working_day')
                ELSE COALESCE(x.non_working_day_rule, 'previous_working_day')
           END AS rule
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM public.payroll_schedule_settings s
      WHERE s.effective_from <= p_period_start
      ORDER BY s.effective_from DESC, s.created_at DESC
      LIMIT 1
    ) x ON TRUE
  ), gen AS (
    SELECT public.payroll_generation_date_for(p_period_start, s.first_half_day, s.second_half_day, s.rule) AS d,
           s.days, s.rule
    FROM setting s
  )
  SELECT g.d,
         g.d + (g.days - 1),
         g.days,
         g.rule,
         CASE WHEN EXTRACT(DAY FROM p_period_start) = 16
              THEN LEAST(g.d - 1, (date_trunc('month', p_period_start) + INTERVAL '1 month - 1 day')::DATE)
         END
  FROM gen g;
$$;

REVOKE EXECUTE ON FUNCTION public.payroll_schedule_for(DATE) FROM PUBLIC, anon, authenticated;

-- Upcoming periods only, now with the rule of the half the version starts on.
CREATE OR REPLACE FUNCTION public.payroll_schedule_settings_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_old   DATE;
  v_new   DATE;
BEGIN
  SELECT generation_date INTO v_old FROM public.payroll_schedule_for(NEW.effective_from);
  v_new := public.payroll_generation_date_for(
    NEW.effective_from, NEW.first_half_day, NEW.second_half_day,
    CASE WHEN EXTRACT(DAY FROM NEW.effective_from) = 1 THEN NEW.first_half_rule ELSE NEW.non_working_day_rule END);
  IF v_old <= v_today OR v_new <= v_today THEN
    RAISE EXCEPTION 'Schedule changes apply to upcoming pay periods only: the period starting % has already reached its generation date.', NEW.effective_from
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
