# Overnight report: 2026-11-22 → 23 (Batch 2)

Nothing was changed on live: no merges to ehdd, no migrations, no deploys, no
writes. Read-only queries only. All work is on branch `feat/transfer-remark`
(head `6eabcef` at the time of writing), pushed.

## 1. What's done

| Item | State |
|---|---|
| Full browser suite on `ehdd` (what is live) | Done: 236 tests (the run stopped at 179 when Docker went down; the rest finished in a second pass) |
| "Data gone after idle" | Reproduced and fixed (Batch 2) |
| Part C substitutions | Browser test passes; one scale fix (ID lists read in chunks) |
| Part D AWOL automation | Database checks + browser test pass |
| Part G tenure auto-grant | Database checks + browser test pass; **2 real bugs fixed** (see 3) |
| Part F bulk actions + filters | Browser test passes |
| Transfer remark | Browser test passes |
| "Date hired not set" on HR's Action needed + the Super Admin create fix | Done |
| Admin / Super Admin not on payroll | Done (migration, form, server, Part G / AWOL skip, tests) |
| "Leave & Overtime" (was My Leave) | Done for Employee, HR, Accountant; screenshots in `docs/reports/leave-overtime/` |
| Unit tests | 1552 / 1552 pass |
| Smoke | 17 / 17 pass |

## 2. Test results

### On `ehdd` (live code)

| Test | Result | Verdict |
|---|---|---|
| 10-access: Admin blocked from other portals | Failed once (connection reset); **passes alone** | Test issue: the local dev server was still compiling when the test started |
| 57 idle pages: HR User Management "lines gone after idle" | Failed once; passes alone | **App bug** (small, also live today): while the branch list is still loading, every row says "Unknown branch", then the real names appear. Reproduced on purpose by slowing that one request. No data is lost. Fixed in Batch 2. |
| 4 skipped tests | Skipped | By design: they need the payroll flow earlier in the same pass, or special flags. Payslip print was rerun after the payroll flow: passes. |
| Everything else | Passed | — |

Idle investigation details:

- Plain idle + focus change: nothing lost in 12 cycles on 4 pages.
- A failed refresh (500 or network drop): tables that had rows keep them.
- A refresh that "succeeds" but returns empty data blanks a list. The app cannot tell that apart from a truly empty list, so I left it.

### On the Batch 2 branch

| Test | Result | Verdict |
|---|---|---|
| Unit tests | 1552 pass (2 failed first) | 1 test issue (a label check expected "My Leave"); 1 **app issue** in my Part C code (an unchunked ID list, which can fail at scale): fixed |
| Part D database checks | Pass (failed first) | Test issue: the test branch had nobody present, so the check rightly saw a dead terminal |
| Part G database checks | Pass (failed first) | **App bug ×2** (see 3), plus test-data issues (setup refused by guards) |
| Browser tests: 17 spec files (C, D, F, G, idle fix, transfer remark, Admin not on payroll, AWOL, HR management, and every spec touched by the rename) | All pass | First run: 32 passed, 5 failed. All 5 were test issues (an outdated tab name from my Part G rename; the Add form opens on Admin; an invalid teacher level in the setup; ambiguous rows; a UTC date in Manila's morning) |
| Leave & Overtime spec (4 tests) | Pass | — |
| Smoke | 17 / 17 | — |

No check was removed or loosened. Where a test changed, it now reaches the same check another way, or checks more. Examples: test setup is now checked to have worked, and the separated-employee test also checks that the New request button is gone.

## 3. Real bugs found and fixed tonight (Batch 2)

1. **"Unknown branch" while loading** (HR User Management, live today). The cell now shows a loading placeholder; "Unknown branch" only appears if the branch list fails after its retries.
2. **Failed table refresh.** The rows stay, with "Couldn't refresh, retrying… Showing the last loaded data." It retries by itself after 5, 15 and 45 s, then leaves "Try again".
3. **Part G, the System could never grant.**
   - The grants table required a person (`granted_by`) on every grant.
   - Its guard only accepted HR, and never an effective date before today.
   - Your forward-only rule starts a grant at the cutoff in progress, which can be a few days earlier.
   - The daily job would have failed on its first grant.
   - Fix: a narrow exception in the guard for the System's grant. It must be made inside the database (never through the API; a forged one is refused, and that is tested), and it never starts before the cutoff in progress. The column now allows an empty person.
4. **Part C:** an ID list read in one query (scale rule); now read in chunks.
5. **Super Admin "Add staff account"** saved the date hired only in the login account's data, not in the employee record (this is why Nona Guido and Jane Benitez had none).

## 4. Decisions I made (safest option)

- **The Leave & Overtime form is in a dialog.**
  - One New request button opens it, with the type chosen at the top (Leave (whole days) / Half day / Overtime).
  - Page addresses are unchanged (`emp-leave`, `hr-my-leave`, `ac-my-leave`), so old links and saved pages still work and open the Leave tab. `?lo_tab=half|overtime` opens the other tabs.
  - After filing, the page switches to that type's tab.
- **Leave notification links:** for HR and Accountants, the bell's leave notifications now open their own Leave & Overtime page (they used to point to the Employee page id). Half-day notices open the Leave tab, not the Half day tab: a notification carries only a page id.
- **I committed the rename as work in progress before taking the screenshots.** It's on the branch only; nothing merged.
- **Two non-additive schema changes in the Part G migration**, raised here as the release process requires (both backward compatible; nothing existing changes behaviour):
  - `tenure_protection_grants.granted_by` may be empty (a system grant);
  - the grants guard function gains the System's branch; the rules for people are word for word the same.
- **Admin migration:** it stops (changes nothing) if any automatic Absent row or AWOL case exists for an Admin or Super Admin. Checked read-only tonight: 0 and 0.
- **Date-hired copy:** Jane Benitez only, as you confirmed. Nona Guido is held back.
- **Part G daily job is NOT scheduled** by any migration. It's enabled separately, after the release, on your yes.
- **Part C** has no database scenario file. It's covered by unit tests and the browser test.

## 5. Batch 2 release plan (waiting for your yes and for Nona Guido's date)

**Contents (41 commits on `feat/transfer-remark`):**
- transfer remark;
- Part F (checkboxes, filters, bulk actions);
- Part C (substitutions);
- Part D (AWOL automation);
- Part G (tenure auto-grant, job off);
- "Date hired not set" + the create fix + the copy;
- Admin / Super Admin not on payroll;
- the idle fixes;
- Leave & Overtime.

**Migrations (6; live has 173 now → 179):**

| Version | What | Kind |
|---|---|---|
| 20261123010000_transfer_decision_note | 1 column | additive |
| 20261123020000_substitutions | table, trigger, settings | additive |
| 20261123030000_awol_automation | columns, table, settings, functions, cron `awol-daily-review` | additive (**the AWOL cron starts running daily**) |
| 20261123040000_tenure_auto_grant | setting, functions; NOT NULL relaxed; guard replaced | **non-additive ×2** (see 4); no cron |
| 20261123050000_date_hired_backfill | data: Jane Benitez's date hired | data |
| 20261123060000_admin_not_on_payroll | data: 5 accounts off payroll (logged); stops if Absent / AWOL rows exist | data |

**Steps (one evening, like Batch 1):**

1. **Pre-check (read-only):**
   - No payroll run in progress. Tonight 1 is draft/pending: it must be approved, or confirmed safe, first.
   - Live migrations = 173.
   - Admin Absent / AWOL rows = 0.
   - Nona's date: if confirmed, add her row to the copy before release; otherwise she stays out.
2. **Backup:** database + storage (as `backups/2026-11-22_1527`). Rollback SQL for the replaced functions: the old `tenure_protection_grants_guard` (from 20261110010000), plus `DROP` statements for the new objects.
3. **Release branch** `release/batch-2` from `feat/transfer-remark`, PR into `ehdd`, CI checks.
4. **Migrations live first**, in order, via the Management API (`apply.sh`); live = 179 afterwards. These are safe with the old code still running: the new columns and tables are unused until the deploy, and the AWOL cron only prepares notices for HR.
5. **One merge** into `ehdd`, which is one deploy. Wait for Vercel READY.
6. **Live checks:**
   - unauthenticated health check;
   - read-only queries: 179 = 179; 5 Admin / Super Admin off payroll; Jane's date hired set; the `awol-daily-review` cron present and `tenure-auto-grant` absent;
   - then your signed-in checks: Leave & Overtime (three roles), HR Action needed, Tenure tabs, AWOL page, Substitutes, bulk selections.
7. **Rollback, if needed:**
   - Vercel: promote the previous production deployment.
   - Database: the changes are additive except the guard (restore the old function from the backup SQL) and the two data changes (Jane's date hired: set back to empty; Admin flags: set back from the audit entries).
8. **After the release, separately on your yes:**
   - Part G first-run list (read-only), then `SELECT cron.schedule('tenure-auto-grant', '45 16 * * *', 'SELECT public.tenure_auto_grant();');`.

## 6. Still open

- Nona Guido's real date hired.
- Your yes for the Batch 2 release, and later for the Part G daily job.
- Your review of the Leave & Overtime screenshots (`docs/reports/leave-overtime/`).
- Batch 3 (E automation, I sidebar) and A2 (deferred).


## 7. Update 2026-11-23 morning: AWOL automation OFF until enabled (your decision)

- **Found:** an AWOL detection job, `awol-flag-candidates`, **already runs on live every night** (00:20 Manila, from an earlier release). The Batch 2 migration replaces the function that job calls.
- **Now:** after the release, AWOL automation is OFF.
  - The new setting `hr.awol_auto_from` is empty; while it's empty, detection, the device check and the daily review do nothing.
  - Both jobs (`awol-flag-candidates` and `awol-daily-review`) are set INACTIVE.
  - This also stops the old nightly detection on live until you enable it.
- **Enabling:** `SELECT public.awol_automation_enable();` sets the date to today, turns both jobs on, and is logged.
  - Only absences on or after that date ever count, and the device check never looks earlier either.
  - A past date is refused.
- **Checks:** off does nothing; absences before the enable date never count; enabling sets the date and turns on the jobs; plus all earlier scenarios. All pass, and both AWOL browser tests pass on a fresh seed.

### Dry run on live (read-only, today's live data, run date Nov 22, new rules without the enable-date gate)

| Who | Absences | Result |
|---|---|---|
| Default Employee | Nov 12–13, 16–19 no taps | **No case**: every one of those days, all of Main Branch (7–8 people) had no taps. That counts as a device or data problem, never as AWOL. |
| Jane Dela Pena Benitez (Employee), Jane Marinel (HR) | Nov 12–19 no taps | **No case**: same gap days |
| Ehd Astillero Refuerzo (Employee, SACS-001) | Nov 12–19 no taps | **No case**: same gap days (also a pending leave Nov 18–20) |
| Jane Marinel Dela Pena Benitez (Accountant) | Nov 11, 12, 13 | Would match, but she **already has an open case** (Oct 7), so no second case is opened |

- The first run without the gate would also have recorded **10 device-problem days** (Main Nov 12–19, Robinson Nov 16–19) and notified HR of each. With the gate, nothing before the enable date is looked at.
- Already on live (opened by the old job): open "flagged" cases for Default Employee, both Janes (Employee and Accountant, Oct 7), Jane (HR, Nov 6) and Ehd Astillero (Oct 9). Batch 2 leaves them as they are.

### Rollback SQL
Prepared from live's definitions and tested locally (ROLLBACK). It:
- restores the 3 replaced functions (`awol_flag_candidates`, `backup_export_tables`, the grants guard);
- reactivates `awol-flag-candidates` and removes `awol-daily-review`;
- drops the new functions and puts back `granted_by NOT NULL`;
- reverses Jane's date hired and the 5 Admin flags.
