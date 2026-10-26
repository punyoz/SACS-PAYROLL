-- SSS, PhilHealth and Pag-IBIG as percentages from the October 2026 2nd half
-- (decision 2026-10-26), instead of from November 1 (20261026020000).
--
-- contribution_method is read on each 2nd half's first day, and the month's
-- contributions are all deducted on the 2nd half. October 1-15 is already
-- paid but carried no contributions, so starting on October 16 changes no
-- paid payslip: October 16-31 (not processed yet) deducts SSS 5% of the
-- salary credit, PhilHealth 2.5%, Pag-IBIG 2% up to ₱10,000 instead of the
-- fixed ₱300 / ₱400 / ₱400.
--
-- Additive (a new effective-dated version). Safe to run more than once.

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT 'contribution_method', 'global', NULL, 0, DATE '2026-10-16',
       'SSS, PhilHealth and Pag-IBIG computed from the legal rates from the October 2nd half (decision 2026-10-26)', 'System (percentage contributions)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs
  WHERE rate_type = 'contribution_method' AND scope = 'global' AND effective_date = DATE '2026-10-16'
);
