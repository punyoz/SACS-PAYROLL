# Part I: sidebar map (step 1, for approval)

Each current sidebar item, read from the code (2026-11-23), and where it goes.

Rules (from the Part I request):
- one sidebar item per module, with tabs inside the page;
- each tab has its own URL, and old URLs redirect to the right tab;
- badges are per tab and summed on the sidebar item;
- filters are kept per tab;
- permissions are unchanged and no feature is removed.

Nothing is built until this map is approved. After approval, the Accountant moves first.

**Flags** mark the points that need a decision:
- **DUP**: two pages that may duplicate each other;
- **MISFIT**: a page with no place in the requested list;
- **NEW**: a tab with no page today.

## Accountant: 22 items → 9 (+1, see A)

| New item | Tabs (current page id) |
|---|---|
| Dashboard | Overview (`ac-dashboard`) |
| Process Payroll | Single entry · Batch · Submit to HR / run status, all three today inside `ac-process` |
| Payroll Records | Payslips (`ac-payslips`) · Payroll runs (`ac-records`). **DUP:** check whether the two lists show the same rows; if they do, merge them into one tab |
| Loans & Subsidies | Loans (`ac-loans`) · Cash advances (`ac-cash-advances`, old and new sources) · Subsidies (`ac-approvals`). One "New" button with a type |
| Additional Pay | Incentives & Overload (`ac-incentives`) · Substitution pay **NEW** (today inside Process Payroll lines) · Tenure pay **NEW** (read-only list) |
| 13th Month & Final Pay | 13th month (`ac-13th`) · Final pay (`ac-final-pay`) |
| Attendance | Records (`ac-attendance`) · Holidays & Duty (`ac-holidays`) |
| Reports | Payroll monitoring (`ac-monitoring`) · Payroll reports (`ac-reports`) · Remittances / BIR (inside reports) · Government rates (`ac-gov-rates`, read-only) **MISFIT A** |
| My Account | My Attendance (`ac-my-attendance`) · My Timesheet (`ac-my-timesheet`) · My Payslips (`ac-my-payslips`) · My Requests: Leave & Overtime (`ac-my-leave`) plus money items (`ac-my-requests`) · Profile (`ac-profile`) |

- **MISFIT A, Announcements (`ac-announcements`):** not in the requested list. Proposal: a tab on Dashboard (Overview · Announcements).
- **Government Rates:** not in the list either. Proposal: a read-only tab under Reports, as in the table above.

## HR: 26 items → 8

| New item | Tabs (current page id) |
|---|---|
| Dashboard | Overview (`hr-dashboard`) · Announcements (`hr-announcements`) **MISFIT** |
| Employees | Management (`hr-employees`) · Status & contracts **NEW** (split out of User Management) · Tenure pay (`hr-tenure`) · AWOL cases (`hr-awol`) |
| Approvals (one inbox) | All · Leave / Half day / Overtime (`hr-leaves`) · Time corrections & flags (inside `hr-leaves` today) · Schedules & transfers (`hr-transfers` plus schedule items from `hr-branch-requests`) · Incentives, loans & subsidies (`hr-adjustment-approvals` and `hr-subsidy-approvals`) · Substitutions (inside `hr-leaves` today) · Payroll runs (`hr-payroll-approval`) · Final pay (inside Payroll Approval today) · Branch reports: the incident and RFID kinds of `hr-branch-requests` |
| Attendance | Monitoring (`hr-attendance`) · Work schedules (`hr-schedules`) **MISFIT B** · Holidays & Duty (`hr-holidays`) · RFID: cards (`hr-rfid-cards`), terminal (`hr-rfid-terminals`), issues (RFID branch requests) |
| Payroll Records | Read-only (`hr-payroll-records`) |
| Reports | HR reports (`hr-reports`) |
| Settings | Government rates (`hr-gov-rates`) · Status & leave credit rules (`hr-classification-rules`) · Request policy **NEW** (today in System Configuration) · Substitution rates **NEW** (same) · Preset remarks (`hr-remark-presets`) · Automation **NEW** (the Automation card's pause switches and settings) |
| My Account | The same 6 personal pages as the Accountant (`hr-my-*`, `hr-profile`) |

- **MISFIT B, Work Schedules:** defining schedules is not listed. Proposal: an Attendance tab.
- **Branch Requests:** today one mixed list. Its items split by kind into the matching Approvals and Attendance tabs; nothing is lost.

## Branch Admin: 16 items → 5 (+1, see C)

| New item | Tabs (current page id) |
|---|---|
| Dashboard | Overview (`adm-dashboard`) · Announcements (`adm-announcements`) |
| Branch Attendance | Attendance (`adm-attendance`) |
| Branch Review (one check list) | Leave (`adm-leaves`) · Overtime & Substitute (`adm-overtime`) · Transfers (`adm-transfers`) · Incentives (`adm-incentives`) · Schedules (`adm-schedules`) |
| Incidents & RFID | Incident & AWOL reports (`adm-incidents`) · RFID issues (`adm-rfid-issues`) · RFID terminal & cards (`adm-maintenance`) |
| My Account | Profile (`adm-profile`) |

- **MISFIT C:** Payroll Summary (`adm-payroll`), Branch Reports (`adm-branch-reports`) and Pay Rates (`adm-pay-rates`) are not in the 5. Proposal: a sixth item, **Branch Reports** (Payroll summary · Branch reports · Pay rates). Alternatively they become Dashboard tabs and the count stays at 5.

## Employee: 8 items → 6

| New item | Tabs (current page id) |
|---|---|
| Dashboard | `emp-dash` |
| My Attendance | Attendance (`emp-attendance`) · Timesheet (`emp-timesheet`) · Substitutions I covered **NEW** (a filtered list) |
| My Requests | Leave · Half day · Overtime · Time correction (`emp-leave` today), with one "New request" button |
| My Payslips | Payslips (`emp-payslips`) · Loans & other pay (`emp-requests` today) **MISFIT D** |
| Announcements | `emp-announcements` |
| My Profile | `emp-profile` |

- **MISFIT D:** today's "My Requests" (`emp-requests`) is the employee's loans, cash advances, incentives, subsidy and 13th month, all read-only. The request names that item for leave, overtime and time corrections. Proposal: the money list becomes a My Payslips tab, and the old URL redirects there.

## Super Admin: 15 items → 8

| New item | Tabs (current page id) |
|---|---|
| Dashboard | Overview (`sa-dashboard`) · Items waiting on fallback (`sa-fallback`) · Announcements (`sa-announcements`) |
| Accounts | Admin & HR accounts (`sa-accounts`) · Roles & permissions (`sa-roles`) |
| Branches | `sa-branches` |
| Attendance Records | `sa-attendance` |
| RFID | Cards (`sa-maintenance`) · Terminal (`sa-rfid-terminal`) · Issues (`sa-rfid-issues`) |
| System | Configuration (`sa-config`) · Backup & Recovery (`sa-backup`) |
| Audit & Monitoring | `sa-audit` |
| My Account | Profile (`sa-profile`) |

## Also updated with the move
- Dashboard cards, Action needed, notification and email links open the right tab.
- Old `?page=` ids redirect to their new tab (the My Requests aliases already work this way).
- The E2E tours and page sweep use the new ids. The old ids stay as redirects, so links already sent still work.
