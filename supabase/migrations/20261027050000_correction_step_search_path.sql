-- Supabase advisor "function_search_path_mutable" (2026-10-27, after
-- 20261022020000_payroll_corrections went live): payroll_correction_step had
-- no fixed search_path. Pin it like every other public function. No data or
-- behaviour change (it only builds a JSON history step).
ALTER FUNCTION public.payroll_correction_step(TEXT, public.profiles, TEXT, TEXT, NUMERIC) SET search_path = public;
