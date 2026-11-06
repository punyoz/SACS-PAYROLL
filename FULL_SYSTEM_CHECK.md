# Full system check: 2026-11-05/06

A live Playwright run of the whole Payroll Management System (Shepherd Angels
Christian School) against the **local** Supabase stack and the `*@e2e.test`
accounts, with bugs fixed and re-tested on branch `fix/full-system-check`
(tag `before-full-check` = `c0c99b1`). No live data was read beyond read-only
checks, and nothing was applied to live from this branch.

Re-run it live (PowerShell):

```powershell
$env:E2E_TIME_TRAVEL=1; $env:E2E_SLOWMO=500; npx playwright test
# then the three specs that need October 16-31 fresh, each in its own pass:
npx playwright test --project=desktop e2e/specs/20-payroll-flow.spec.mjs e2e/specs/98-handoff-rollover.spec.mjs
npx playwright test --project=desktop e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-partial-runs.spec.mjs
npx playwright test --project=desktop e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-tags-override-tour.spec.mjs
```

Report: `npx playwright show-report test-results/final-3/html-full` (videos,
traces, screenshots in `test-results/final-3/artifacts-full`).

## 1. Numbers

Final round (2026-11-06): **160 of 160 tests passed** (desktop 151, phone 9):
the full run passed 155, and the other 5 passed in their own runs: the three
October 16-31 specs in separate passes (98 handoff 3/3, partial runs 2/2,
tags/override tour 2/2) and 62-rfid-edge after a test-expectation fix
(half day). Unit tests 1179/1179, lint clean, `next build` passes.

| Role | Sidebar pages opened (desktop, phone, phone dark mode) | Controls exercised in the page sweep | Workflows it takes part in |
| --- | --- | --- | --- |
| Super Admin | 10 | 149 | accounts, override, BIR read-only, rates, schedule, audit, branches, announcements |
| Admin | 14 | 85 | leave / transfer / schedule endorsements, AWOL reports, kiosk, branch isolation |
| HR | 20 | 310 | approvals (payroll, leave, loans, incentives, subsidies), accounts, RFID cards, schedules, holidays, transfers, salary changes |
| Accountant | 17 | 182 | process / draft / generate / submit, partial runs, loans, 13th month, final pay, BIR, corrections |
| Employee | 7 | 16 | leave, timesheet, payslips, notifications, profile |
| **Total** | **68** | **742** | **about 45 workflows in 29 specs** |

Plus: 259 text boxes checked for letters/numbers rules, maximum lengths,
empty and pasted oversized text (UI), 107 server-side input probes, and 402
role-boundary API calls. Every page is watched the whole time: any console
error, page error or failed request fails the test.

Passed vs failed over the whole check: run 1 found the Critical payroll bug at
step 82; full runs then went 138 → 146 → 151 → 155 passed as app and test
fixes landed (one run was disturbed by another session resetting the local
database, another by Docker stopping; neither counted).

## 2. Migrations

| Where | Count | Status |
| --- | --- | --- |
| Repo files (this branch) | 128 | 126 + 2 new (`20261105010000`, `20261105020000`) |
| Local database | 128 | matches the repo files after every reset |
| Live database | 129 | all repo files + `20261105030000_leave_proofs_bucket` (from the Supabase Pro branch, merged into `ehdd` as 6c76408) |

- Nothing was missing anywhere. Six live history rows carry apply-time stamps
  instead of the file stamps (known and accepted since 2026-10-21); the names
  match one to one.
- The two new migrations (advisor fix; employee-type repair) were written and
  applied locally here; the Supabase Pro session committed identical copies,
  and they were applied to live with your approval there. Verified live
  afterwards: policy and index exist, 0 employee-type mismatches, security
  advisor 0 findings.
- Before merging `ehdd` into this branch, delete the two untracked copies
  (byte-identical to `ehdd`).

## 3. Database, functions and API

- 67 public tables locally and live, RLS on all 67. Not in the documented
  data stores (DFD catalog): `rfid_terminals`, `role_permissions`.
- Every database function the code calls exists. Exists but never called:
  `payroll_pending_run_count`. Live also has an Edge Function
  `attendance-nightly` that is not in the repo and is not called (the nightly
  close runs as SQL through pg_cron). Neither was deleted.
- Live cron jobs: all 4 succeeded on 2026-11-05, 0 failures in 14 days.
- Advisors (live): security, before: `payroll_run_exclusions` without a deny
  policy (fixed), leaked-password protection off; after: 0 findings.
  Performance: one unindexed foreign key (fixed), 135 "unused index" notes
  (informational; the indexes cover foreign keys).
- API: every GET route (67) called by every role and signed out:
  402 calls, 402 as expected (`test-results/final-3/api-matrix.json`).
  Write routes are covered by the role-boundary, validation (107 probes) and
  workflow specs.

## 4. Bugs found, fixed and re-tested

Severity: Critical (payroll cannot be done or is wrong), Moderate (wrong data
or a security gap), Minor (layout, wording, a dead end with a workaround).
"Step" is the numbered terminal line of the run that first showed it.

### Accountant

| # | Severity | Where | What happened | Fix | Re-test |
| --- | --- | --- | --- | --- | --- |
| 1 | Critical | Process Payroll | Opened on last month's period (e.g. October 1-15 on Nov 5), the page showed that period's figures but "Process payroll for all" sent this month's period and was refused (403). The October 16-31 window that runs into November could not be processed from the screen. (run 1, step 82) | The period list now always offers last month's two halves and the period on screen (`getPeriodOptions`). | 20-payroll-flow passes (process → reject → resubmit → approve → employee sees payslip). |
| 6a | Minor | Loans / Incentives / Cash Advances, employee picker | A long employee name made the page wider than a phone. | The picker takes its column's width. | Phone sweep passes. |
| 6b | Minor | Process Payroll, "No Final payslip yet" line | A long name pushed the page 12 px past a phone's edge. | The line wraps. | Phone sweep passes. |

### HR

| # | Severity | Where | What happened | Fix | Re-test |
| --- | --- | --- | --- | --- | --- |
| 5 | Moderate | User Management > Add employee, CSV import | Every new hire was saved as "Teaching" and "Active" in the record payroll and lists read, whatever was entered (only HR's edit saved them). Two live people were affected. | The create route saves both; migration `20261105020000` corrected the two live rows (approved payslips untouched). | 12-login-accounts / 62-rfid-edge show "Non-Teaching" as entered. |
| 6c | Minor | Leave Approval | A 500-character reason without spaces made the page 3,843 px wide on a phone; Reject was off-screen. | The reason wraps; the card can shrink. | Phone leave flow passes. |
| 7 | Minor | Government Rates, "Check a monthly taxable income" | No maximum (15 digits accepted). | Max ₱1,000,000 like the salary field. | 98-input-validation passes. |

### Employee

| # | Severity | Where | What happened | Fix | Re-test |
| --- | --- | --- | --- | --- | --- |
| 4 | Minor | Leave | A leave overlapping a pending or approved one was accepted, but HR can never approve it (409), so it sat in HR's queue. (leave spec, step 3) | Refused when filed: "These dates overlap a pending leave request …". | 33-leave-extra passes. |

### Every role

| # | Severity | Where | What happened | Fix | Re-test |
| --- | --- | --- | --- | --- | --- |
| 2 | Moderate | Sign out | A copy of the session cookie taken before signing out still worked afterwards. (login spec, step 41) | Sign out ends the sign-in on the server. Automatic trips to the login page only clear the cookie, so a stale tab cannot end a newer sign-in. | Replayed cookie → 401. |
| 3 | Minor | Change password | Re-opening the dialog within 60 s stopped at "Please wait 60 seconds" though the emailed code was still valid. (login spec, step 31) | Goes on to the code step, as sign-in and reset do (each code still allows 5 tries). | 12-login-accounts passes. |

### Super Admin / Admin

| # | Severity | Where | What happened | Fix | Re-test |
| --- | --- | --- | --- | --- | --- |
| 6d | Minor | Branch Management | A long branch location made the page 695 px wide on a phone. | Wraps. | Phone sweep passes. |
| 6e | Minor | Admin > Branch Dashboard | A 50-letter first name pushed the type badge off a phone screen. | Wraps. | Phone sweep passes. |

### Database

| # | Severity | What | Fix |
| --- | --- | --- | --- |
| A | Minor | Advisor: `payroll_run_exclusions` had no explicit deny policy and an unindexed foreign key. | Migration `20261105010000` (live). |

### Test-suite problems fixed (not app bugs)

Specs written for a fixed date (58 on Nov 2; 96, 97, 99-partial-runs on
Oct 29) now move the server's date when `E2E_TIME_TRAVEL=1`; a date check in
60 expected "Nov 5" where the app writes "Nov 05"; a role-change scenario
(95 SA-02) left North's Admin without a branch because it skipped the second
call the Edit dialog makes; expired saved sign-ins (60-minute idle timeout)
are no longer restored; five specs that each need October 16-31 untouched run
in their own passes.

## 5. Still open (needs you)

1. **Leave rejection has no reason.** HR rejects with a confirmation only; the
   employee is notified without a why (payroll rejection requires one). Add a
   required reason (new column + dialog field)?
2. **Employee payslip PDF.** Employees see their payslip on screen only; the
   PDF exists for the Accountant and HR. Add a download for the employee?
3. **Role change to Admin without a branch.** The Super Admin's Edit dialog
   sets the branch in a second call; the role-change API alone accepts
   "Admin" with no branch. Make the API refuse it (or set the branch itself)?
4. **Unused objects.** `payroll_pending_run_count` and the live Edge Function
   `attendance-nightly` are unused; keep or remove?
5. **Tables missing from the ERD/DFD**: `rfid_terminals` (kept as a guard
   since the terminals were removed) and `role_permissions`.
6. **Branch count.** The suite seeds 2 branches (+1 made by a scenario), not 4.

## 6. Not built (not counted as failures)

- A reason field on HR's leave rejection (see above).
- Employee payslip PDF download (see above).
- Holiday duty for a past holiday: HR's Holidays & Duty page opens on the next
  holiday; assigning duty to one already past is not offered (by design).

## 7. Not tested here

- The real Gmail → inbox (mail.tm) path: locally the emailed code is planted
  in the database; no mail is sent. Needs the live accounts.
- The live site itself (only read-only checks against the live database).

## 8. Verdict

**READY, once `fix/full-system-check` is merged into `ehdd` and deployed.**
Everything found is fixed and passes live locally, but the Critical fix (#1,
Process Payroll posting the wrong period in the first days of a month) and
fixes #2-#4 and #6-#7 exist only on this branch. Live runs `ehdd`, which
already has #5 and the two migrations.

Shortest list before deployment:
1. Commit this branch; delete the two untracked migration copies first
   (identical to `ehdd`), merge `ehdd` in, re-run the unit tests and build.
2. Merge into `ehdd` and deploy (Vercel).
3. Optional, your decision: the open items in section 5.

## 9. Safety

- No live data was changed from this branch; the two migrations reached live
  through the Supabase Pro session, with your approval there.
- No approved past payroll record was altered (the employee-type repair only
  touched `profiles`; payslips keep the type stored on them).
- `ehdd` (the main branch) is untouched by this work; nothing was committed or
  pushed from `fix/full-system-check`.
