-- Loans page speed (alpha test B4, 2026-11-09).
--
-- GET /api/accountant/loans reads every payment of the listed loans:
--   payroll_loan_payments WHERE loan_id IN (...) ORDER BY created_at, id
-- Until now the only index starting with loan_id was the partial unique
-- payroll_loan_payments_one_per_period (kind = 'payroll' AND NOT reversed),
-- which that query cannot use, so each chunk scanned the whole table.
-- This index serves it directly. Additive; no data is changed. Safe to run
-- more than once.

CREATE INDEX IF NOT EXISTS payroll_loan_payments_loan_idx
  ON public.payroll_loan_payments (loan_id, created_at, id);
