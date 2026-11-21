# Restore from the CSV backup

For the developer. The Super Admin downloads the backup on **Backup & Recovery → Backup → Download everything** (a ZIP of CSV files and `README.txt`). The same text is in every backup's README, under HOW TO RESTORE. Written 2026-11-15.

```text
There is no import screen in the app. A restore is done by the developer, with the
local tool scripts/backup/restore-csv-local.mjs as the worked example (local stack only).

1. When the whole database is lost, first restore the latest daily database backup in the
   Supabase dashboard. Use these CSV files for what changed after that backup, or when no
   database backup is left: then start from an empty database built from the migrations.
2. Sign-in accounts first: users_and_accounts.csv gives each account's User UUID and email.
   Create each account with that same UUID (Supabase Auth admin API), then send password
   resets. Passwords are never in a backup.
3. Load the table files in the LOAD ORDER below (parents before children), in one database
   session with triggers and foreign-key checks off (SET session_replication_role = replica),
   so stored values are not recomputed. profiles and employee_license_documents point at
   each other; with the checks off, the order below loads both.
4. The column guide says where each value goes: [loads into: <column> (<type>)]. Columns
   marked [shown only] are for reading (names, branch names, statuses in words) and are not
   loaded; the "(database code)" column holds the stored status. Turn the formats back:
   date-times are Asia/Manila (+08:00), Yes/No are true/false, an empty cell is NULL (or ''
   for a required text column), a leading ' before = + - @ is removed, JSON stays JSON.
   Payslip amount columns load the amounts of the stored payslip record.
5. Not in the files, redo by hand: the encrypted government ID numbers (re-enter them from
   employees.csv), uploaded files (photos, leave proofs, license scans), bell notifications.
   employees.csv, users_and_accounts.csv, leave_balances.csv and pay_rates.csv are
   summaries: never load them as tables.
6. Check after loading: every table's row count equals "Rows" below; the SHA-256 of each
   file matches; 3 payslips per branch show the same amounts (to the centavo) as in
   payroll_entries.csv; staff can sign in after their password reset.
```

## Load order (parents before children)

1. `branches`
2. `profiles`
3. `employee_positions`
4. `employee_classification_changes`
5. `employee_hr_reminders`
6. `leave_credit_rules`
7. `leave_credit_overrides`
8. `statutory_leave_types`
9. `employee_pay_rules`
10. `leave_requests`
11. `attendance_blocked_taps`
12. `attendance_logs`
13. `attendance_corrections`
14. `attendance_holidays`
15. `attendance_logs_history`
16. `attendance_overtime_approvals`
17. `rfid_terminals`
18. `attendance_taps`
19. `audit_logs`
20. `branch_admin_requests`
21. `branch_announcements`
22. `early_bird_winners`
23. `employee_awol_cases`
24. `employee_branch_assignments`
25. `employee_license_alerts`
26. `employee_license_documents`
27. `employee_license_changes`
28. `employee_salary_changes`
29. `employee_status_changes`
30. `holiday_duty_assignments`
31. `holiday_duty_history`
32. `holiday_work_reviews`
33. `payroll_runs`
34. `payroll_approval_history`
35. `payroll_bir_exports`
36. `payroll_cash_advances`
37. `payroll_contribution_amounts`
38. `payroll_entries`
39. `payroll_subsidy_settings`
40. `payroll_subsidy_balances`
41. `payroll_loans`
42. `payroll_monthly_incentives`
43. `payroll_corrections`
44. `payroll_rate_configs`
45. `payroll_records`
46. `payroll_deductions`
47. `payroll_final_overrides`
48. `payroll_final_pay_submissions`
49. `payroll_incentives`
50. `payroll_loan_payments`
51. `payroll_review_flags`
52. `payroll_run_exclusions`
53. `payroll_run_items`
54. `payroll_schedule_settings`
55. `payroll_setting_changes`
56. `payroll_sss_msc_brackets`
57. `payroll_subsidy_adjustments`
58. `payroll_subsidy_requests`
59. `payroll_tax_annualizations`
60. `payroll_tax_brackets`
61. `payroll_thirteenth_month`
62. `payroll_window_enforcement`
63. `payroll_window_enforcement_changes`
64. `rfid_cards`
65. `rfid_card_events`
66. `role_permissions`
67. `school_break_periods`
68. `system_config`
69. `tenure_protection_grants`
70. `tenure_protection_applications`
71. `tenure_protection_policies`
72. `transfer_requests`
73. `work_schedule_assignments`
74. `work_schedules`

## Worked example (local stack only)

```powershell
node scripts/backup/restore-csv-local.mjs .sacs-payroll_everything_YYYY-MM-DD_HHMM.zip --yes
```

It empties the LOCAL database's backup tables and sign-in accounts, loads the accounts (same UUID and email, no password) and every table in the order above with `session_replication_role = replica`, then compares every table's row count with the README. The test that runs it end to end: `e2e/specs/99-csv-restore-2026-11-15.spec.mjs` (only with `E2E_RESTORE=1`). Never run it against production.

## What a restore does not bring back

- Passwords (people reset them), sign-in codes and sessions.
- The encrypted copies of government ID numbers (`*_enc`): re-enter them from `employees.csv`.
- Uploaded files: profile photos, leave proofs, license scans (Supabase Storage).
- Bell notifications.
- Sub-second precision of date-times (the files keep whole seconds).
- On payslips whose amount columns were never filled (saved before 2026-10-29), the restored columns hold the payslip record's amounts, as the database would have filled them.
