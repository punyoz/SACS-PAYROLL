-- ═══════════════════════════════════════════════════════════════════════════
-- Run in the RESTORED project's SQL Editor after the psql restore
-- (docs/backup-and-restore.md, step R5). Never in the live project.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Put back the ID-number encryption key. Paste the value saved in the
--    school's password manager between the quotes. The dump does not carry
--    Vault secrets, and the new project has its own Vault.
DELETE FROM vault.secrets WHERE name = 'pii_encryption_key';
SELECT vault.create_secret(
  'PASTE-THE-SAVED-pii_encryption_key-HERE',
  'pii_encryption_key',
  'AES-256 key for profiles government IDs and bank account numbers. Do not rotate without re-encrypting.'
);

-- 2. Recreate the scheduled jobs (the cron schema is not in the dump).
SELECT cron.schedule('attendance-nightly-close', '5 16 * * *', $$SELECT public.attendance_close_days(
      ((NOW() AT TIME ZONE 'Asia/Manila')::DATE - 7),
      ((NOW() AT TIME ZONE 'Asia/Manila')::DATE - 1)
    );$$);
SELECT cron.schedule('awol-flag-candidates', '20 16 * * *', $$SELECT public.awol_flag_candidates();$$);
SELECT cron.schedule('holiday-calendar-next-year', '10 16 30 11 *', $$SELECT public.attendance_seed_holidays(EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Manila')::INTEGER + 1);$$);
SELECT cron.schedule('teacher-license-daily', '30 16 * * *', $$SELECT public.teacher_license_daily();$$);

-- 3. Checks. Compare the counts with the same query run on the live project
--    when the backup was taken. "Wrong key or corrupt data" from the last
--    line means the key pasted in step 1 is not the one the data was
--    encrypted with.
SELECT 'accounts' AS item, count(*)::TEXT AS value FROM auth.users
UNION ALL SELECT 'profiles', count(*)::TEXT FROM public.profiles
UNION ALL SELECT 'branches', count(*)::TEXT FROM public.branches
UNION ALL SELECT 'attendance_logs', count(*)::TEXT FROM public.attendance_logs
UNION ALL SELECT 'payroll_entries', count(*)::TEXT FROM public.payroll_entries
UNION ALL SELECT 'payroll_loans', count(*)::TEXT FROM public.payroll_loans
UNION ALL SELECT 'payroll_rate_configs', count(*)::TEXT FROM public.payroll_rate_configs
UNION ALL SELECT 'attendance_holidays', count(*)::TEXT FROM public.attendance_holidays
UNION ALL SELECT 'migrations recorded', count(*)::TEXT FROM supabase_migrations.schema_migrations
UNION ALL SELECT 'scheduled jobs (expect 4)', count(*)::TEXT FROM cron.job
UNION ALL SELECT 'ID numbers stored', count(*)::TEXT FROM public.profiles
  WHERE sss_number_enc IS NOT NULL OR tin_number_enc IS NOT NULL
UNION ALL SELECT 'ID numbers that decrypt (must equal the line above)', count(*)::TEXT FROM public.profiles
  WHERE (sss_number_enc IS NOT NULL AND private.decrypt_pii(sss_number_enc) IS NOT NULL)
     OR (tin_number_enc IS NOT NULL AND private.decrypt_pii(tin_number_enc) IS NOT NULL);
