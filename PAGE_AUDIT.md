# SACS Payroll — Page Audit

Last updated: **2026-10-21** (full audit started 2026-10-20, branch `audit/full-2026-10-20`, tag `before-full-audit-2026-10-20`).

This file lists every page of every portal: what it loads, the API routes and
tables behind it, its actions, who can open it, and its status after the
audit. Update the **Status** column whenever a page changes.

## How every page was tested

All checks ran against a fresh local database built from the 98 migration
files, with a production build of the app and a real sign-in for each role
(email + password + one-time code), in Chromium:

| Check | How | Result |
|---|---|---|
| Data stays on refresh, navigate away and back | Every page: open, count rows, refresh, open the next page, press Back, count again | 57/57 pages identical |
| Loading, empty, error states | Every list/table wired to the shared table (skeleton, "No records yet", error + **Try again**); failed refresh keeps the last rows with a banner | Fixed where missing (see below) |
| Console and network | Page errors, console errors and API responses ≥ 400 recorded per page | None after fixes |
| Every safe control | Every tab, select, refresh, and every button that opens a dialog (opened, checked, closed) | 114 page passes (desktop + phone/dark), no problems |
| Phone width + dark mode | 390 px wide, dark theme, every page: horizontal scroll measured | None |
| Payroll flow | Accountant processes and submits → HR rejects with a reason → Accountant resubmits → HR approves → History | Passed (see "Payroll flow") |
| Same figures everywhere | One payslip's gross / deductions / net compared across six views | Identical to the centavo |
| Access | Each role opens every other portal by URL and calls 20 privileged APIs (reads and writes, other branch, other employee) | All refused after the fix below |
| Database | Fresh replay of all migrations, live-vs-local schema fingerprint, RLS per table, Supabase advisors | Clean (see "Database") |

Legend: ✅ checked, works · 🔧 fixed in this audit · ⚠️ open, needs a decision

## Status labels (one vocabulary)

| Kind | Labels |
|---|---|
| Payroll (records, runs, tabs, badges) | Not submitted to HR · Pending HR Approval · Rejected by HR · Paid (and "On hold" for an entry the Accountant held back) |
| Requests (leave, transfers, branch requests, subsidy adjustments) | Pending · Endorsed · Not endorsed · Approved · Rejected · Resolved (and "Cancelled" for a cancelled leave) |
| Money | ₱ with two decimals (`money`) or compact ₱ (`moneyCompact`) |
| Dates | "Oct 20, 2026"; date + time "Oct 20, 2026, 09:15 AM" |

---

## Super Admin (`/super-admin`) — system functions only

| Page (`?page=`) | Loads (API → tables) | Actions | Status |
|---|---|---|---|
| SA Dashboard (`sa-dashboard`) | `/api/admin/dashboard` (profiles, payroll_records), `/api/admin/system` (profiles) | Shortcuts to pages | ✅ |
| Admin & HR Accounts (`sa-accounts`) | `/api/admin/users` (auth users, profiles, employee_branch_assignments), `/api/admin/branches` | Add account, edit, archive / restore (confirm), reset password, assign Admin branch | ✅ |
| Branch Management (`sa-branches`) | `/api/admin/branches` (branches), `/api/admin/dashboard` | Add / edit branch (dialog), status | ✅ |
| Roles & Permissions (`sa-roles`) | permission matrix (code) | View only | ✅ |
| System Maintenance (`sa-maintenance`) | `/api/admin/system`, `/api/admin/attendance` (attendance_taps, profiles), `/api/hr/branch-requests?kind=rfid_issue` | Open RFID Terminal (password), assign / void RFID card (confirm), resolve RFID issues | ✅ |
| System Configuration (`sa-config`) | `/api/admin/config` (system_config), `/api/admin/holidays`, `/api/admin/payroll-rates`, `/api/admin/payroll-settings`, `/api/admin/payslip-schedule`, `/api/admin/teacher-subsidy`, `/api/admin/early-bird`, `/api/admin/work-schedules` | Save each section, holidays add/remove (confirm), tax table, contributions, payslip schedule, subsidy, Early Bird | 🔧 Licensed Teachers card no longer requested for SA (403); Timezone / Date format / Currency / Pay frequency are read-only and show the values the system uses (they were never used); **Organization name now applies** (see below) |
| Audit & Monitoring (`sa-audit`) | `/api/admin/audit-logs` (audit_logs) | Filter, search, CSV export | ✅ |
| Backup & Recovery (`sa-backup`) | `/api/admin/system`, `/api/hr/employees`, `/api/hr/attendance`, `/api/admin/audit-logs` | Export CSV / JSON | ✅ |
| Profile (`sa-profile`) | `/api/legacy-auth/update-profile` (profiles) | Change password (OTP), edit contact | ✅ |

## Admin (`/admin`) — branch oversight: recommends, never decides

Every page reads `/api/admin/branch-oversight?view=…` (own branch only, from the signed session) unless noted.

| Page | Loads (view → tables) | Actions | Status |
|---|---|---|---|
| Branch Dashboard (`adm-dashboard`) | `dashboard` → attendance_logs, leave_requests, profiles, branch_announcements | Shortcuts | ✅ |
| Branch Attendance (`adm-attendance`) | `attendance` → attendance_logs, branch_admin_requests | Daily / Monthly tabs, day/month picker, Flag issue (dialog → HR) | 🔧 flag history table now shows load errors with Try again |
| Overtime & Substitute (`adm-overtime`) | `requests&kind=overtime_confirmation` | Endorse / Not endorse | ✅ |
| Leave Recommendations (`adm-leaves`) | `leaves` → leave_requests, branch_admin_requests | Waiting for HR / Decided / All tabs, Endorse / Not endorse | 🔧 HR decision labels now Pending / Approved / Rejected |
| Transfer Endorsements (`adm-transfers`) | `transfers` → transfer_requests | Endorse / Not endorse | 🔧 labels as above |
| Incentive Recommendations (`adm-incentives`) | `requests&kind=incentive_endorsement` | Recommend (dialog) | ✅ |
| Schedule Requests (`adm-schedules`) | `requests&kind=schedule_request` | New request (dialog) | ✅ |
| Incident & AWOL Reports (`adm-incidents`) | `requests&kind=incident_report` → branch_admin_requests, employee_awol_cases | Report (dialog) | ✅ |
| RFID Issues (`adm-rfid-issues`) | `requests&kind=rfid_issue` | Report an issue (dialog) | ✅ |
| Announcements (`adm-announcements`) | `/api/announcements` (branch_announcements) | Post, edit, remove (confirm) | ✅ |
| Payroll Summary (`adm-payroll`) | `payroll` → payroll_run_summaries (approved runs, totals only) | View | ✅ totals match HR's run |
| Branch Reports (`adm-branch-reports`) | `reports` (+ PDF) | Month picker, export | ✅ |
| RFID Terminal & Cards (`adm-maintenance`) | `/api/admin/system`, `/api/admin/attendance` | Open terminal, assign / void card | ✅ |
| Profile (`adm-profile`) | `/api/legacy-auth/update-profile` | Change password, edit contact | ✅ |

## HR (`/hr`) — manages employees, decides every approval

| Page | Loads (API → tables) | Actions | Status |
|---|---|---|---|
| Dashboard (`hr-dashboard`) | `/api/hr/dashboard` (attendance_logs, profiles, leave_requests), `/api/hr/teacher-license` | Review now / View all shortcuts, acknowledge license alerts | 🔧 license alerts: no double submit, success message, a failed refresh no longer hides them |
| User Management (`hr-employees`) | `/api/hr/employees` (profiles), `/api/admin/branches`, `/api/hr/teacher-license` | Add / edit employee (dialog), archive / restore (confirm), filters | 🔧 branch names retry instead of showing "Unknown branch" after one failed lookup |
| Transfer Requests (`hr-transfers`) | `/api/admin/branch-employees`, `/api/admin/transfer-requests` (transfer_requests), `/api/hr/branch-requests` | Transfer (dialog), approve / reject pending, history | 🔧 history label "Transferred" → "Approved" |
| Tenure Pay Protection (`hr-tenure`) | `/api/hr/tenure-protection` (tenure_protection_*, school_break_periods) | Grant / revoke (dialog), school breaks save / remove | 🔧 removing a school break now asks first; tables show load errors |
| Attendance (`hr-attendance`, `hr-att-employee`) | `/api/hr/attendance`, `/api/attendance/logs`, `/api/attendance/corrections`, `/api/attendance/overtime`, `/api/attendance/employee/:id`, `/api/admin/holidays` | Date / range view, correct record, review corrections and overtime, suspensions | ✅ |
| Work Schedules (`hr-schedules`) | `/api/admin/work-schedules`, `/api/admin/early-bird` | Profiles, assign, level, archive | ✅ |
| Leave Approval (`hr-leaves`) | `/api/hr/leave-requests` (leave_requests), `/api/hr/branch-requests` | Approve / reject (confirm), cancel approved (confirm), proof viewer | 🔧 employee is now notified; dates "Oct 20, 2026" |
| AWOL Cases (`hr-awol`) | `/api/hr/awol-cases` (employee_awol_cases), incident reports | Confirm, notices, reply, separate / close | ✅ |
| Branch Requests (`hr-branch-requests`) | `/api/hr/branch-requests` (branch_admin_requests) | Approve / reject / resolve with remark | ✅ |
| Payroll Approval (`hr-payroll-approval`) | `/api/hr/payroll-runs` (payroll_run_summaries, payroll_run_items, payroll_approval_history), live stream | Tabs, filters, Review, Approve (one or many), Reject (reason required), PDF / Excel / Print | 🔧 tabs and badges use the payroll labels; the tab and open run survive a refresh |
| Payroll Records (`hr-payroll-records`) | `/api/hr/payroll-records` (payroll_entries, payroll_runs) | Period / branch filters, View payslip, print / PDF | 🔧 filters survive a refresh; an old period in a link shows all records |
| Subsidy Approvals (`hr-subsidy-approvals`) | `/api/admin/approvals` (payroll_subsidy_requests; applies to payroll_subsidy_adjustments, payroll_loans) | Status tabs, Approve / Reject (reason required) what the Accountant processed, Decision history | 🔧 2026-10-21: Accountant processes, HR approves; Requested / Processed / Approved-by columns; statuses Pending · Processed · Approved · Rejected · Applied to payroll; tab survives refresh |
| HR Reports (`hr-reports`) | `/api/hr/reports` | Report type, date range, export | ✅ |
| Profile (`hr-profile`) | `/api/legacy-auth/update-profile` | Change password, edit contact | ✅ |

## Accountant (`/accountant`) — processes payroll; HR approves it

Most pages share one load: `/api/accountant/payroll[?period=]` (payroll_entries, payroll_records, payroll_runs, attendance_logs, profiles, rates…).

| Page | Loads | Actions | Status |
|---|---|---|---|
| Dashboard (`ac-dashboard`) | shared load | Shortcuts | 🔧 recent-activity table shows a failed refresh |
| Process Payroll (`ac-process`) | shared load, `/api/accountant/payroll-runs` | Pay period, Generate / Regenerate / Generate final, batch, save draft, Submit / Resubmit for HR Approval (confirm) | 🔧 **the chosen pay period survives a refresh** (a run being resubmitted used to drop out of view) |
| Payroll Records (`ac-records`) | shared load (`history_records`, every period) | Search, Payslip | ✅ |
| Payslips / Pay Record (`ac-payslips`) | shared load (`entry_id`) | Choose entry, print, PDF | ✅ |
| Loans (`ac-loans`) | `/api/accountant/loans` | Add, suspend / resume; subsidy advance and excess conversion / refusal are processed for HR | 🔧 2026-10-21: a subsidy advance is released only after HR approves |
| Incentives & Overload (`ac-incentives`) | `?view=monthly_items` | Add, remove (confirm), month | 🔧 deferred table shows load errors |
| Cash Advances (`ac-cash-advances`) | shared load | Hold / resume / cancel (confirm) | ✅ |
| 13th Month Pay (`ac-13th`) | `?view=thirteenth_month` | Year, Process (confirm) | ✅ |
| Subsidies (`ac-approvals`) | `/api/admin/approvals` | Process adjustment / advance / excess settlement, Fix & resubmit what HR rejected | 🔧 2026-10-21: renamed from "Subsidy Adjustments"; processes every subsidy item; HR's reason shown on rejection |
| Final Pay (`ac-final-pay`) | `/api/accountant/final-pay` | Compute, release | ✅ |
| View Attendance (`ac-attendance`) | shared load, `/api/attendance/logs`, OT confirmations | View only | 🔧 table shows load errors with Try again |
| Payroll Monitoring (`ac-monitoring`) | shared load | Status tabs, Edit / Cancel draft (confirm), Payslip | 🔧 tabs are the payroll labels; a failed load shows an error (it showed "No payroll records found") |
| Payroll Reports (`ac-reports`) | shared load | Type, period, branch, export, print | ✅ |
| Profile (`ac-profile`) | `/api/legacy-auth/update-profile` | Change password, edit contact | ✅ |

## Employee (`/employee`)

| Page | Loads | Actions | Status |
|---|---|---|---|
| Dashboard (`emp-dash`) | `/api/employee/stats`, `/api/employee/payslips`, `/api/employee/leave-requests`, `/api/announcements` | Shortcuts | ✅ |
| Attendance (`emp-attendance`) | `/api/attendance/logs`, `/api/attendance/corrections` | Request correction (dialog) | ✅ |
| Timesheet (`emp-timesheet`) | `/api/employee/timesheet` | Range, copy, CSV | ✅ |
| Payslips (`emp-payslips`) | `/api/employee/payslips` (approved runs only) | View, print | ✅ hidden until HR approves; matches the Accountant's figures |
| Leave (`emp-leave`) | `/api/employee/leave-requests` | File leave (form), history | 🔧 status showed "Pending_admin" → "Pending"; bell count of pending requests was always 0 |
| Profile (`emp-profile`) | `/api/legacy-auth/update-profile` | Edit contact, emergency contact, change password | ✅ |

## Other pages

| Page | Roles | Status |
|---|---|---|
| `/login` | everyone | ✅ password + emailed code; wrong role / no role refused |
| `/rfid-terminal` | Super Admin / Admin (password-locked kiosk) | ✅ |
| `/supabase-status` | diagnostic | ✅ |
| Bell (every portal) | everyone | 🔧 now stored for: payslip released (employee), leave filed (HR), leave decided / cancelled (employee), subsidy adjustment requested (HR) and decided (Accountant), on top of the payroll-run and branch-request notices. Survives a refresh. |

---

## Payroll flow (local, real sign-ins)

1. Accountant generates Final payslips for Oct 1–15 (4 employees) and submits → **Pending HR Approval**; the employee sees no payslip. ✅
2. HR's bell shows the run (after a refresh). Reject with no reason is refused in the dialog; with a reason → **Rejected by HR** tab, History keeps it. ✅
3. Accountant's bell shows the rejection; Process Payroll shows "Rejected by HR" with HR's reason; **Resubmit** → Pending HR Approval, still after a refresh. ✅
4. HR approves → **Paid** tab, History has both decisions, nothing pending. ✅
5. Employee sees the payslip and the bell says "Your payslip is ready"; a North Branch employee sees nothing of it. ✅
6. Same figures (gross / deductions / net) in Accountant Records, Monitoring, HR Payroll Records, the run items, the run totals, the Admin's Payroll Summary and the employee's payslip. ✅

## Access (each role, by URL and by API)

Every role was sent to every other portal by URL (always returned to its own), and called 20 privileged endpoints. One gap was found and fixed: **HR could list the Super Admin and Admin login accounts** through `/api/admin/users` (no HR screen uses it). It now returns only the roles the caller may manage. Branch scope held everywhere (the Accountant and Admin see only their branch; an employee's `employee_id=` parameter is ignored).

## Database

- **Fresh replay:** all 98 migrations apply cleanly on an empty database (`supabase db reset`).
- **Drift:** the live schema matches the replayed one exactly: columns (881), constraints (362), indexes (222), policies (84), functions (101), triggers (78), views (3), cron jobs (4), client grants (0).
- **History:** 98 rows = 98 files. One row is stamped `20261018032608` for the file `20261018010000` (same content, applied before it was renamed). Left as is by decision; new migrations must be stamped after it.
- **RLS:** on for all 53 tables, every table has policies, and `anon` / `authenticated` have no table grants. The browser never reads tables directly; every read goes through a server route that checks role and branch, so "RLS returns zero rows" cannot blank a page.
- **Advisors:** security — only *Leaked password protection* (an Auth setting; may need a paid plan). Performance — 78 "unused index" notices, all foreign-key indexes on a small database; kept on purpose.
- **Foreign keys considered, not added:** five `payroll_entry_id` / `payout_entry_id` columns have no foreign key. Live has no orphans. Their tables block hard deletes by design, so a cascading or set-null key would collide with that rule (and could make "Withdraw draft" fail). Left as is.

## Organization name

System Configuration → General → Organization name (saved value on live: "SACS") is now the system's short name everywhere it appears:

- the portal header, "**SACS** Payroll" (all five portals, via `/api/rbac/me`);
- payslips: "Payslip - **SACS** Payroll Management System" (PDF from the Accountant and HR) and the on-screen Pay Record;
- the sign-in, password-reset and password-change code emails: subject, sender name and footer (`MAIL_FROM_NAME` on the server still overrides the sender name).

A change shows within a minute. The school's full legal name on payslips and the payroll sheet is not this setting (the sheet keeps its own "school name"). The sign-in page, shown before anyone signs in, keeps the school name as it is.

## Decisions (2026-10-21)

- Live history row `20261018032608` stays as it is. Every new migration must be stamped after it; `tests/migration-names.test.js` enforces this (see `docs/local-migration-replay.md`).
- Leaked password protection: skipped for now, listed in `docs/go-live.md` §11 as a future improvement.
- Timezone, Date format, Currency, Pay frequency: kept, read-only, showing the real values. Organization name: applied (above).

## Still open

- ⚠️ The last-viewed tab on some pages (Admin Leave Recommendations, Accountant Monitoring, HR Attendance date) still resets to its default on refresh; data stays, only the view resets.
