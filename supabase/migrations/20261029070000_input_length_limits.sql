-- Input limits the database enforces too (input validation audit, 2026-10-29).
--
-- The screens and API routes cap these fields; until now the columns took any
-- length or amount, so a direct write could store a 5,000-character branch
-- name or a ₱1,000,000,000,000 tax bracket. Each limit matches its form box
-- and route:
--
--   branches.name                      1-80 characters  (Add / Edit branch; /api/admin/branches)
--   leave_requests.reason              at most 1,000    (Leave; /api/employee/leave-requests)
--   payroll_corrections.reason         at most 500      (Correct; /api/payroll/corrections)
--   payroll_rate_configs.value         at most 9,999,999.99 (Government rates; rates.js)
--   payroll_tax_brackets.bracket_over,
--   payroll_tax_brackets.base_tax      at most 9,999,999.99 (Tax table; /api/admin/payroll-settings)
--
-- Added NOT VALID, then validated: validation fails (and nothing changes) if
-- an existing row is already outside its limit. Safe to run more than once.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branches_name_length') THEN
    ALTER TABLE public.branches ADD CONSTRAINT branches_name_length
      CHECK (char_length(btrim(name)) BETWEEN 1 AND 80) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_reason_length') THEN
    ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_reason_length
      CHECK (reason IS NULL OR char_length(reason) <= 1000) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_corrections_reason_length') THEN
    ALTER TABLE public.payroll_corrections ADD CONSTRAINT payroll_corrections_reason_length
      CHECK (char_length(reason) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_rate_configs_value_max') THEN
    ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_value_max
      CHECK (value <= 9999999.99) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_tax_brackets_amount_max') THEN
    ALTER TABLE public.payroll_tax_brackets ADD CONSTRAINT payroll_tax_brackets_amount_max
      CHECK (bracket_over <= 9999999.99 AND base_tax <= 9999999.99) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.branches VALIDATE CONSTRAINT branches_name_length;
ALTER TABLE public.leave_requests VALIDATE CONSTRAINT leave_requests_reason_length;
ALTER TABLE public.payroll_corrections VALIDATE CONSTRAINT payroll_corrections_reason_length;
ALTER TABLE public.payroll_rate_configs VALIDATE CONSTRAINT payroll_rate_configs_value_max;
ALTER TABLE public.payroll_tax_brackets VALIDATE CONSTRAINT payroll_tax_brackets_amount_max;
