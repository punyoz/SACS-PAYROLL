# E2E Test Report — 2026-10-22

Playwright suite in `e2e/` (how to run: `e2e/README.md`). Local Supabase stack
(fresh `supabase db reset`, all 101 migrations) and local `next dev`; no live
data touched. Test accounts: `e2e/accounts.mjs`, created by `e2e/seed-e2e.mjs`.

**Status: full suite passes.** Final run from a fresh database: **86 passed, 0 failed,
0 console errors, 0 unexpected failed requests** (42 min headless). Unit tests
916/916, lint and `next build` pass.

## Bugs found and fixed

| # | Page / role | Steps | Expected | Happened | Root cause | Fix | Regression test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Accountant > Process Payroll → Pay Record; HR > Payroll Records (payslip + PDF) | Process payroll for all, open a payslip / its PDF | Branch "Main Campus"; PDF position "Teacher" (as single Generate prints) | Branch "—" on screen and PDF; PDF position "Employee" | The batch path (`batch_submit`) never stored the branch name / position title; only single Generate did | Batch payslips store `payslip_meta` (branch, position title); the payslip builder reads it | `20-payroll-flow` (Branch on the batch payslip) | Fixed, verified |
| 2 | Every date field (37 DatePickers): HR license expiry, leave, AWOL, schedules, tenure… | Open a date field, look for a date after Dec 2026 | Any future date | Year list and arrows stop at Dec 31, 2026; a PRC expiry can never be entered; from ~Dec 24 no January leave (7-day rule) | react-day-picker caps a dropdown calendar at the end of the current year when no `endMonth` is given | `DatePicker` passes `endMonth` = its `max`, else 10 years ahead | `25-subsidy-flow` (expiry 2029-06-30) | Fixed, verified |
| 3 | Accountant > Process Payroll, Payslips (Pay Record), Payroll Reports | Payroll data fails to load | An error with Try again | "No employees found" with Process enabled; empty pickers; no reason | Pages read `data` from the shared loader and ignored its `error` | Same `ErrorState` + retry as Dashboard / Records | `80-layout-states` (failing API) | Fixed, verified |
| 4 | Employee > Dashboard | Attendance / payslip data fails to load | An error with Try again | "No attendance yet this month", "No payslips yet" | The cards ignored the hooks' `error` | Both cards show `ErrorState` + retry | `80-layout-states` (failing API) | Fixed, verified |

## Not bugs (checked, by design)

| Observation | Why it is correct |
| --- | --- |
| Typing letters in an RFID card number registers the digits only | Card numbers are digits only, up to 16 (the field strips the rest; the DB checks `^[0-9]{1,16}$`) |
| Super Admin cannot move October's 2nd-half payslip day to the 20th | Schedules apply only to periods whose generation day has not arrived |
| Nothing filed on Oct 22 is deferred | October's incentive cutoff is Oct 29 (day before the 2nd-half payslip day); the test plants a past cutoff to check deferral |

## Results by area

| Page / area | Role | Test | Result | Bug found | Fix applied | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Portals + APIs | signed out, all 5 roles | `10-access` (6 tests) | Pass | — | — | Done |
| Payroll flow | Accountant, HR, Employee | `20-payroll-flow` | Pass | #1 | yes | Done |
| Subsidy flow | SA, HR, Accountant | `25-subsidy-flow` | Pass | #2 | yes | Done |
| Leave flow | Employee, Admin, HR | `30-leave-flow` | Pass | — | — | Done |
| AWOL / incidents | Admin, HR | `40-awol-flow` | Pass | — | — | Done |
| Transfers, schedules, tenure, branch scope | HR, Admin, Admin (North), Accountant | `50-hr-management` (4 tests) | Pass | — | — | Done |
| RFID | HR, terminal, Employee | `60-rfid-flow` | Pass | — | — | Done |
| Incentive cutoff, late 0% | Accountant, Employee | `70-incentives-late` (2 tests) | Pass | — | — | Done |
| Phone width + dark mode, all pages | all 5 roles | `80-layout-states` | Pass | — | — | Done |
| Loading + error states, all pages | all 5 roles | `80-layout-states` | Pass after fixes | #3, #4 | yes | Done |
| Every page / sub-tab / control: refresh, away-and-back, search, filters, sort, paging, dialogs (empty submit), exports | all 5 roles | `90-page-sweep` (59 tests) | Pass | — (only harness fixes) | — | Done |

## Open (not fixed)

| Item | Detail |
| --- | --- |
| Slow request | HR > Attendance > an employee's records (`GET /api/attendance/employee/:id`, Oct 1–22) took over 5 s twice on the local stack. Not a failure; worth profiling if it is slow on live too. |
| Existing batch payslips | Fix #1 applies to payslips processed from now on. Batch payslips already stored still show Branch "—" until they are reprocessed. |
| Visual review | Overlap and cut-off text are not machine-checked. Phone-width dark-mode screenshots of every page are in `test-results/screens/` for a human look. |

## Where the evidence is

- HTML report: written by `npm run test:e2e` to `test-results/html/` (`npx playwright show-report test-results/html`); the run above used the plain line reporter, so it has no HTML report
- Videos + traces per test: `test-results/artifacts/<test>/video.webm`, `trace.zip`
- Screenshots: on failure in `test-results/artifacts/`; every page at phone width in dark mode in `test-results/screens/`
- Console / network log per test: `test-results/issues.jsonl`
