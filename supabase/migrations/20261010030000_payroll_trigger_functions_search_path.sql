-- Pin the search_path of the two payroll trigger functions the Supabase
-- security advisor flags as "Function Search Path Mutable" (lint 0011):
--
--   public.payroll_append_only()               20261009010000_payslip_schedule_loans_awol_subsidy.sql
--   public.payroll_cash_advances_read_only()   20261009030000_cash_advances_read_only.sql
--
-- Both bodies only RAISE an exception and name no table, function or type,
-- so the empty search_path is the strictest setting and changes nothing they
-- do. ALTER FUNCTION keeps their owner, grants and triggers as they are.
-- Safe to run more than once.

ALTER FUNCTION public.payroll_append_only() SET search_path = '';
ALTER FUNCTION public.payroll_cash_advances_read_only() SET search_path = '';
