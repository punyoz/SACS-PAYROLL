-- The employee is told when an override changes their payslip (decision
-- 2026-10-29). An override applies only to a payslip HR approved, which is
-- when it was released to the employee ("Your payslip is ready"), so every
-- override that changes a figure changes a payslip the employee could
-- already see. Silence there is how pay disputes start.
--
-- A trigger on public.payroll_final_overrides (20261029040000) writes the
-- notification in the same transaction as the override itself: no override
-- that changes a figure can be saved without it. An override that changed
-- nothing (the recomputed payslip came out the same) sends nothing.
--
-- Additive: one function, one trigger. Nothing else changes.

CREATE OR REPLACE FUNCTION public.payroll_final_overrides_notify_employee()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_peso CONSTANT TEXT := 'FM999,999,990.00';
BEGIN
  IF cardinality(COALESCE(NEW.changed_fields, '{}')) = 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (recipient_id, kind, title, body, link_page, run_id)
  VALUES (
    NEW.employee_id,
    'payslip_corrected',
    format('Your %s payslip was corrected', NEW.pay_period),
    format('Your %s payslip was corrected after HR approval. Net pay: ₱%s → ₱%s (payslip %s replaced by %s). Reason: %s',
      NEW.pay_period,
      to_char(COALESCE((NEW.old_values ->> 'net_pay')::NUMERIC, 0), v_peso),
      to_char(COALESCE((NEW.new_values ->> 'net_pay')::NUMERIC, 0), v_peso),
      COALESCE(NEW.old_payslip_no, '—'), COALESCE(NEW.new_payslip_no, '—'),
      NEW.reason),
    'emp-payslips',
    NEW.run_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_final_overrides_notify_employee ON public.payroll_final_overrides;
CREATE TRIGGER payroll_final_overrides_notify_employee AFTER INSERT ON public.payroll_final_overrides
  FOR EACH ROW EXECUTE FUNCTION public.payroll_final_overrides_notify_employee();

REVOKE ALL ON FUNCTION public.payroll_final_overrides_notify_employee() FROM PUBLIC, anon, authenticated;
