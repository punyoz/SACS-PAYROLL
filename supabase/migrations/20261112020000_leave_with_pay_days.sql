-- Leave with pay: 6 days per calendar year (decided 2026-11-12; was 15 in code).
--
-- The yearly allotment is now a Super Admin setting (System Configuration →
-- Payroll → "Leave with pay per year"), read by My Leave, Final Pay's unused
-- leave and the backup. There is no balances table: each balance is computed
-- from APPROVED leave of that calendar year, so this row alone recalculates
-- the current year's balances as 6 minus the paid leave already used (never
-- below 0). Past years keep 15 (src/lib/leave-requests/store.js
-- allotmentForYear); no leave request, attendance row or payslip is changed.
-- An existing value (a Super Admin's choice) is left as it is.

INSERT INTO public.system_config (section, key, value, updated_at)
VALUES ('payroll', 'leave_with_pay_days', '6', NOW())
ON CONFLICT (section, key) DO NOTHING;
