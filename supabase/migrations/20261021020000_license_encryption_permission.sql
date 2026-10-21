-- HR could not switch on a licensed teacher (found 2026-10-21).
--
-- employee_license_changes_apply() (20261009010000) encrypts the PRC number
-- with private.encrypt_pii(), which only its owner may run (the PII key stays
-- out of reach of the app's role, 20260927080000). The trigger ran as the
-- caller, so every "turn on" / "update details" from HR failed with
-- "permission denied for function encrypt_pii" (shown as "You do not have
-- permission to perform this action."). Live had no licensed teacher, so no
-- subsidy could ever open.
--
-- The trigger now runs with its owner's rights, as the profile PII triggers
-- already do. Its body is unchanged; it already pins search_path to public,
-- and it is reached only through inserts into employee_license_changes,
-- which the app makes for HR alone (/api/hr/teacher-license). No data changes.

ALTER FUNCTION public.employee_license_changes_apply() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.employee_license_changes_apply() FROM PUBLIC, anon, authenticated;
