-- Check for 20261123070000_substitution_line_type.sql: a substitution payslip line (no attendance log,
-- as Part C writes it) is accepted; an unknown type is still refused. One transaction, rolled back.
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/substitution-line-type.sql
-- Ends with NOTICE "substitution line type: ok".
BEGIN;
DO $$
DECLARE v_ok BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.payroll_incentives (employee_id, pay_period, type, quantity, unit, rate, amount, is_override, note)
  VALUES ((SELECT id FROM public.profiles ORDER BY created_at LIMIT 1), 'November 16-30, 2026', 'substitution', 1.5, 'hour', 150, 225, FALSE, 'Substitution check');
  BEGIN
    INSERT INTO public.payroll_incentives (employee_id, pay_period, type, amount, is_override, note)
    VALUES ((SELECT id FROM public.profiles ORDER BY created_at LIMIT 1), 'November 16-30, 2026', 'not_a_type', 1, TRUE, 'x');
  EXCEPTION WHEN check_violation THEN v_ok := TRUE;
  END;
  ASSERT v_ok, 'an unknown line type is still refused';
  RAISE NOTICE 'substitution line type: ok';
END $$;
ROLLBACK;
