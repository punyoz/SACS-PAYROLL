-- ═══════════════════════════════════════════════════════════════════════════
-- Leave credits: ONE shared pool per employee per year ("Leave Credits",
-- 2026-11-24), drawn by Vacation, Sick and Emergency leave (they stay leave
-- TYPES). Defaults per Category x Status: Regular 5, Probationary /
-- Provisional / Contractual 3; from the 1-year service anniversary the Regular
-- rule, pro-rated (as before). Statutory leaves never use the pool. Days used
-- are counted from the approved requests, so nothing is converted: the
-- per-type rules stay as history and are no longer read once these exist.
-- Applied after the owner's yes on the per-employee dry run.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.leave_credit_rules DROP CONSTRAINT IF EXISTS leave_credit_rules_leave_type_check;
ALTER TABLE public.leave_credit_rules ADD CONSTRAINT leave_credit_rules_leave_type_check
  CHECK (leave_type = ANY (ARRAY['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Leave Credits']));
ALTER TABLE public.leave_credit_overrides DROP CONSTRAINT IF EXISTS leave_credit_overrides_leave_type_check;
ALTER TABLE public.leave_credit_overrides ADD CONSTRAINT leave_credit_overrides_leave_type_check
  CHECK (leave_type = ANY (ARRAY['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Leave Credits']));

INSERT INTO public.leave_credit_rules (leave_type, employee_type, employment_status, employment_type, days_per_year, effective_from, note, created_by_name)
SELECT 'Leave Credits', et.v, st.v, ty.v, CASE WHEN st.v = 'Regular' THEN 5 ELSE 3 END, DATE '2026-01-01', 'Default: one shared pool (2026-11-24)', 'System'
FROM (VALUES ('Teaching'), ('Non-Teaching')) et(v)
CROSS JOIN (VALUES ('Regular'), ('Probationary'), ('Provisional'), ('Contractual')) st(v)
CROSS JOIN (VALUES ('Full-time'), ('Part-time')) ty(v)
ON CONFLICT DO NOTHING;

