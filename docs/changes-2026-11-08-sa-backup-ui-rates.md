# 2026-11-08 — Super Admin backup, announcements, shared UI fixes, daily / hourly rates

Branch `feat/sa-backup-ui-rates-2026-11-08` (from `ehdd` 7b7c2c0). Three new
migrations, local only until approved for live:

| Migration | What it does |
| --- | --- |
| `20261108010000_sa_backup_exports.sql` | SECURITY DEFINER functions `backup_export_page / _count` and `backup_payroll_export`: an active Super Admin only, service role only, secrets and file blobs stripped. Functions only, no data changed. |
| `20261108020000_sa_posts_announcements.sql` | `announcement_post` / `announcement_edit` accept the Super Admin (posts like HR, edits its own); RLS insert policy; `role_permissions` super_admin/announcements = full. |
| `20261108030000_hourly_rate_always_derived.sql` | Trigger refuses any new `hourly` row in `payroll_rate_configs` and a daily rate of 0 or less; `role_permissions` for the read-only `pay_rates` module. No row changed or deleted. |

## 1. Super Admin payroll export
- Before: the button showed "Payroll export requires accountant portal access." The check was a hard-coded early return in `backup-page.jsx`; nothing on the server.
- Now: `GET /api/admin/backup/payroll?format=csv|xlsx` (proxy `backup_recovery`, route role check, database function). Every branch, read-only, amounts exactly as stored, privacy confirmation first, audit entry `backup_payroll_export` with the row count. No Accountant page or `process_payroll` right.
- The Accountant's own exports (Reports page) are unchanged and built in the browser from its branch-scoped `/api/accountant/payroll` data: payroll summary (employee, period, gross, deductions, net, status), the school payroll sheet (days, hours, rate, OT, contributions, tax, net per branch) and holiday work.

## 2. Full data backup (.xlsx)
- `GET/POST /api/admin/backup/full`; `src/lib/backup/full-backup.js`; streaming writer `src/lib/export/xlsx-stream.js` (no dependency; sheet by sheet, 1,000 rows a batch, a sheet over 1,000,000 rows continues in "(2)", long JSON over several cells).
- Password re-entry (`src/lib/auth/reverify-password.js`), 5 downloads per 15 minutes counted from the audit log, audit entries for start / finish / failure / wrong password, nothing stored on the server.
- Ten groups (users, employees, attendance, leave, payroll, benefits, rates, branches, announcements, audit) with per-group downloads. Excluded and why: listed in the workbook's first sheet and in `BACKUP_EXCLUSIONS`.
- Restore guide card; Recovery procedures corrected (daily backups 7 days; point-in-time recovery not enabled).
- Service status: the check now times out after 20 s and always says what failed (before: an error reply cleared the message and a slow reply left empty loading bars).

## 3. Super Admin announcements
Never built for the Super Admin (left as an open decision on 2026-10-30); now posts like HR through the same component and route.

## 4–8. Shared UI
- `TableToolbar` (search first, filters on the same row; stacked on phones) used by `DataTable` and `BranchGroupedTable`; `FilterTabs` for tab filters.
- `SearchableSelect` for long lists; `SelectContent` defaults to a bounded popper list without scroll buttons.
- `scrollbar-none` utility (sidebar, tab rows); number inputs without spinner arrows (`data-stepper` opts back in).
- Toasts: one config in `src/components/ui/sonner.jsx` (top right, under the header).

## 9. Rates
- The hourly rate is never typed (UI, API `hourly_rate_derived`, database trigger); always `roundPeso(daily / 8)` (`hourlyFromDaily`), its history built from the daily history.
- Typed hourly rows kept: ₱68.75 (Jan 1, in force before Oct 1), ₱75.00 (from Oct 1, typed Sep 28) and ₱72.00 (from Oct 16, typed Oct 13) are "superseded: now automatic"; payroll has not read them for any period from Oct 1, 2026.
- A daily change needs a reason; the audit entry has old → new daily and hourly.
- Branch rates: daily + automatic hourly + effective date, "uses system default"; read-only view for HR (all), Accountant and Admin (own branch): `GET /api/payroll/pay-rates`.

## Owner decisions (2026-11-08, second round)
- Plain ID numbers stay in the backup; no Excel password; notifications, sign-in data and files stay out. The Restore guide says: "Uploaded files are not included in this export and must be backed up separately."
- Shared toolbar also on HR Payroll Approval and the attendance status board. Kept their own layout, with the reason: System Configuration (page sections, no list), Subsidy approvals (one filter over three tables), Loans and Holiday duty (the tabs pick a form).
- Hourly rounding `roundPeso`; the typed ₱75 / ₱72 rows stay as superseded history.
- Final pay takes its daily rate by the payroll rule (`finalPayDailyRate`): a daily rate set for one employee wins; no salary → branch / system rate. A saved final pay is never recomputed (409).
- `profiles.is_demo` (`20261108040000_is_demo_flag.sql`): default false, no existing row flagged (awaiting the owner's approval of a list); set only by `e2e/scale/demo-60.sql`. Skipped by the Super Admin backups and CSVs, HR reports, branch reports, remittance, BIR forms / alphalist / stored BIR files, the payroll-run Excel export, and the Accountant's payroll sheet, holiday work and Reports page (`src/lib/demo.js`). Working screens (processing, attendance, approvals) still show demo people.
