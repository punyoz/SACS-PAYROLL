# Batch 3: migration list (for your yes before any release)

Live today has none of these. Every migration was run on the local stack only. Live was checked read-only on 2026-11-23: of everything Batch 3 defines, only the five functions marked **replaces** already exist there.

## Release A: additive (one release)

| # | Migration | What it does | Kind |
|---|---|---|---|
| 1 | 20261124010000_automation_framework | `automation_actions` table, log / close / daily (forward, escalate, digest), pause per module, dry run | additive (+ backup list) |
| 2 | 20261124020000_attendance_flags | Nightly attendance flags (missing tap, absent with no request, short day, overtime not filed, patterns) | additive, cron 00:45 |
| 3 | 20261124030000_schedule_automation | Schedule request checks, release dry run | additive, cron |
| 4 | 20261124040000_attendance_correction_requests | Correction requests with pay effect (columns on `attendance_corrections`, new functions) | additive |
| 5 | 20261124050000_self_approval_rules | HR may file their own correction requests (another HR decides) | permission row |
| 6 | 20261124060000_leave_recommendations | Staffing check for leave recommendations | additive |
| 8 | 20261124080000_incentive_recommendations | Perfect Attendance / Early Bird wait for HR (from the Nov 16 cutoff) | additive (+ backup list) |
| 9 | 20261124090000_rfid_issues | Nightly RFID issue flags (unknown / lost / inactive / wrong-branch card, quiet terminal by 09:00) | additive, cron 00:47 |
| 10 | 20261124100000_employment_type_full_time | Employment type default Full-time; empty values set to Full-time (live has no Part-time) | data: NULL → Full-time |
| 11 | 20261124110000_provisional_maintenance_leave_defaults | Provisional status, Maintenance group, leave defaults 5/5 Regular and 3/3 new (only the untouched "pending policy manual" rows) | widens checks; **replaces** `employee_probation_end`, `employee_hr_reminders_run` (both now include Provisional) |
| 12 | 20261124120000_honorarium_bonus_adjustment | Honorarium, Bonus, Adjustment kinds; `reason` and `non_taxable` columns | widens checks; **replaces** the view `payroll_exempt_benefits_paid` (one more term: bonus items) |
| 14 | 20261124140000_framework_tracking | Overtime requests, substitutions and AWOL cases tracked in the framework | additive triggers |

`backup_export_tables` is redefined in #1, #8 and #13. Each version only adds table names to the backup list.

## Release B: transfers (own release, explicit yes)

| 7 | 20261124070000_transfer_automation | **replaces** `apply_transfer_request_approval` | old vs new: `docs/reports/transfer-trigger-change.md`; rollback: `scripts/rollback/rollback-transfer-automation.sql`; check: `scripts/checks/transfer-trigger-equivalence.sql` |
|---|---|---|---|

## Release C: special working days (own release, explicit yes)

| 13 | 20261124130000_special_working_days | **replaces** `attendance_schedule_for` (the attendance schedule every tap, close and check uses). The old body is kept word for word as `attendance_schedule_base_for`; the new function differs only when a special working day covers the employee. It also adds the payslip line types `substitution` (a Batch 2 bug: such a line was refused on save) and `special_working_day` | rollback: `scripts/rollback/rollback-special-working-days.sql`; check: `scripts/checks/schedule-equivalence.sql` (old vs new for every employee and day, with no special day declared) |
|---|---|---|---|

The `substitution` line-type fix is also a one-line additive change. It can go out with Release A if you prefer: Part C goes live with Batch 2, and a substitute's payslip can't be saved until it ships.

## Order and checks at release
1. A backup is taken, and the rollback scripts are ready.
2. The migrations run in order (A; later B; later C).
3. Read-only checks follow.
4. The automation dry run per module runs in a READ ONLY transaction: `SET LOCAL automation.dry_run = 'on'` for each nightly function.
5. Only then are the modules enabled.
