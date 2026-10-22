# Real-world scenario catalog — SACS Payroll

Stress test of 2026-10-22, branch `feat/scenarios-scale-2026-10-22`. Every
scenario was run on the **local** stack with test accounts only, never live.

**Status:** **Pass** = handled as found · **Fixed** = failed, root cause fixed,
regression test added · **Built** = no way to handle it existed; the smallest
proper feature was added (with tests) · **Decided** = needed a business decision
(made 2026-10-22) and was built as decided · **Open** = known limit, with a
recommendation.

Also found by the E2E run: the new "Many cards" button made the RFID Cards
header 10 px too wide on phones (HR, Admin, Super Admin) — fixed (the buttons
wrap) and covered by `80-layout-states`.

Rules never changed here: only HR manages employees and approves; only the
Accountant processes payroll; the Super Admin runs the system only; the Admin
recommends for its own branch; late charge 0%; incentives filed after the
cutoff go to next month's payroll.

**Tests:** E2E = `e2e/specs/*` (Playwright, local), unit = `tests/*` (Vitest),
scale = `e2e/scale/*` (1,210 people, 6 branches, 5 years, local).

## Scale — 1,200 employees, 6 branches, 5 years

Dataset (`node e2e/scale/seed-scale.mjs --reset`): 1,210 accounts, 1,562,362
attendance rows, 141,944 payslips, 708 approved runs, 18,000 leave requests,
1,000,000 audit rows — **1.96 GB** database.

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| SC-01 | all | Every page at 5 years of data | Load in a usable time | scale `measure.mjs` (production build) | **Fixed.** Before: the server **ran out of memory and crashed** (Accountant pages read all 142k payslips with their 9 KB JSON), and 8 pages answered 500 ("URI too long"). After: all 59 pages load; non-Accountant pages median 0.8 s (max 2.3 s); Accountant pages 3.6–6.6 s. |
| SC-02 | HR | Employee list, 1,210 people | Search and filter fast | scale API timing | **Pass** (0.3 s, 944 KB; search and filters in the page). *Open:* past ~3,000 accounts, move it to server paging like Payroll Records. |
| SC-03 | HR / Accountant / Admin | Attendance at millions of rows | Date-bounded server queries | scale + EXPLAIN | **Fixed.** Branch lists of 300+ people failed ("URI too long"); overtime read `.limit(5000)` and dropped rows; the not-tapped roster stopped at 1,000. All chunked and paged. |
| SC-04 | Accountant / HR | 142k payslips of history | Paged / windowed | scale + unit `scale-queries` | **Fixed.** HR Payroll Records: server paging, search and totals (`payroll_entries_totals`). Accountant: history = last 12 months, or any year (Year filter on Records / Monitoring / Reports); light rows only. |
| SC-05 | SA | Audit log, 1M rows | Searchable, filtered in the database | scale + E2E `95` | **Fixed.** Filters ran in memory over the newest 150 rows only. Now module / action / words / date range in SQL, trigram indexes (search 556 ms → 15 ms), match counts. |
| SC-06 | DBA | Indexes on hot filters | Every hot query indexed | EXPLAIN ANALYZE | **Fixed.** Added audit (trigram, module, actor), attendance (branch, date), payslips (newest first). Rewrote `attendance_close_days` (run on every payroll load): **4.0 s → 0.8 s**. |
| SC-07 | Accountant | Process payroll for a 300-employee branch | Reasonable time, retry-safe | scale `payroll-run.mjs` | **Fixed + Pass.** 303 payslips in **9.2 s**; the same request replayed twice at once: **0 duplicates**. Fixed on the way: 2nd-half payroll would fail or be refused at 300+ people (loans / subsidy context), and the semi-monthly context read only 1,000 payslips (a 1st half could look unpaid). |
| SC-08 | HR / SA / Admin | Dashboards at scale | Aggregated in the database | scale API timing | **Fixed.** SA dashboard answered 500 (URI too long); HR's pending-leave count read every request. Dashboards now 0.07–0.18 s. |
| SC-09 | SA | Year 5: old data | Read-only, searchable, nothing lost | design | **Decided:** keep everything online; move to Supabase Pro before the Free plan's 500 MB. Approved runs are already locked for good. |
| SC-10 | HR | Onboard from a CSV file | Validate every row, error report | E2E `95`, unit `employee-csv-import` | **Built.** User Management → Import CSV: template, check (nothing created), import in batches through the Add employee route, per-row report. (The E2E test caught that the first template had no Account status column, so every row was refused; the column was added and defaults to Active.) |
| SC-11 | HR | Many RFID cards at once | Bulk register with per-row errors | E2E (via cards API) | **Built.** RFID Cards → Many cards: register or replace, per-line result and report. |
| SC-12 | HR | Bulk schedule / contract updates | Bulk with history | existing E2E sweep | **Pass** for schedules (Assign schedule / Set level for up to 500, effective-dated, audited). *Open:* bulk change of contract fields (employment type / status) — recommend a CSV "update" mode on Import. |
| SC-13 | HR | Export the employee list | One file | manual | **Built.** User Management → Export CSV (the list as filtered; no government IDs). |
| SC-14 | SA | Database size after 5 years | Fits the plan or a plan to | size query | **Decided + Built:** 1.96 GB at 5 years vs 500 MB Free. SA Dashboard health shows the size, amber from 350 MB, red at 500 MB. |

## Employee

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| EM-01 | HR | Forgot / lost the card, no tap | HR records the day by hand | E2E `95` | **Pass** (Attendance → correct record, with reason; card replaced in RFID Cards). |
| EM-02 | Employee | Tapped twice | "Already recorded", no second row | E2E `60` | **Pass** |
| EM-03 | Employee | Tapped at 2:00 AM | Refused or flagged | E2E `95`, unit | **Decided + Fixed.** It became the day's time in (and could win the Early Bird tie-break). A card time in more than 3 h before the employee's own shift start is refused and kept in Blocked Taps; manual entries are not judged. |
| EM-04 | Employee | Terminal offline | Taps saved and synced | code review | **Pass** (offline taps carry their time; unusable ones go to Blocked Taps). |
| EM-05 | Employee | Disputes a payslip | Breakdown and history | E2E `20`, `95` | **Pass** (full breakdown on the payslip; a wrong approved payslip is now corrected through AC-08). |
| EM-06 | Employee | Files leave, tracks it | Status at every stage | E2E `30` | **Pass** |
| EM-07 | Employee / Accountant | Transfer mid-period | Correct single pay, traceable | code + unit | **Decided + Built.** One payslip in the branch at processing (as before); the payslip (screen and PDF) now lists the days worked in each branch. *Not yet tested end to end.* |
| EM-08 | HR / Accountant | Resigned / terminated mid-period | Final pay, card off, access handled | E2E `95`, unit | **Built.** Only an AWOL case could separate anyone, so no one else ever reached Final Pay. HR → Edit → Separate…: last day + reason; status Separated, pay held for Final Pay, card deactivated, taps refused; archive after final pay. |
| EM-09 | Employee | Back from long leave / break | Rules continue | unit `tenure-pay-protection` | **Pass** (school breaks are configured; taps resume normally). |
| EM-10 | Employee | Refuses to sign for an excess subsidy advance | Recorded settlement | unit `subsidy-processing` | **Pass** (refusal recorded; HR decides offset / waive / final pay / collect). |
| EM-11 | HR | Same name / birthday as another | Kept apart, HR warned | E2E `95`, unit | **Fixed.** No check existed. Same first + last name and birthday (archived included) now asks HR to confirm; employee ID and email keep them apart. Multi-word last names ("Dela Cruz") are matched whole (caught by the E2E rerun). |

## Accountant

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| AC-01 | Accountant | 300 employees, some missing attendance | The rest processed, missing ones listed | scale | **Pass** (unresolved days wait per employee; 303 processed in 9.2 s). |
| AC-02 | Accountant | Run rejected by HR | Fix and resubmit | E2E `20` | **Pass** |
| AC-03 | Accountant | Late incentive after cutoff | Next month, notice | E2E `70` | **Pass** |
| AC-04 | Accountant | Mid-period salary change | Defined rule | design | **Pass** (the salary on file when processed pays the period; a raise effective earlier is paid as a correction, AC-06). |
| AC-05 | Accountant | New hire mid-period | Prorated | unit `new-hire-proration` | **Pass** |
| AC-06 | Accountant | Retroactive adjustment | Approved, on a later payslip | E2E `95`, unit | **Decided + Built** (with AC-08). |
| AC-07 | Accountant / HR | Overtime / substitute to confirm | Paid only when confirmed | unit, E2E sweep | **Pass** |
| AC-08 | Accountant / HR | Payslip wrong after HR approved it | Correction flow, original kept | E2E `95`, unit | **Decided + Built.** Payroll Records → Correct (underpayment or overpayment, reason); HR approves or rejects (reason) on Payroll Approval; fix & resubmit; history kept. Approved: an underpayment becomes an incentive item on the next payroll, an overpayment a recovery deduction over N payslips. The approved payslip never changes. |
| AC-09 | Accountant | Own payslip | Not processed alone | unit `role-separation` | **Pass** (decided 2026-10-20: system-computed only, HR approves). |
| AC-10 | Accountant | Contributions, tax, loans, cash advance together | All applied, net never negative | unit | **Pass** |
| AC-11 | Accountant | 13th month, annual reports, BIR 2316 / alphalist | Year figures and the BIR forms | scale (2.9 s for 2025), E2E `95`, unit `bir-forms` | **Pass** for 13th month and yearly totals. **Decided + Built** for the BIR forms: Payroll Reports → BIR forms (year, per-employee 2316 PDF, all 2316 in one PDF, 1604-C alphalist as Excel or CSV — Schedule 1 as of Dec 31, Schedule 2 separated during the year). Computed from paid, HR-approved payslips, final pays, and the 13th month / other-benefit ledger (exempt up to the ceiling, the rest taxable); tax due from the annual table. Tax due vs withheld and the difference are shown; the Accountant settles a difference with a payroll correction (no automatic December adjustment). Employer TIN, RDO, address, ZIP and signatory: SA → System Configuration → General → BIR employer details. HR sees every branch read-only (Payroll Records); the employee downloads their own 2316 for a finished year (Payslips → My BIR 2316). Not the BIR `.DAT` file; previous employer, minimum wage and de minimis are not recorded, so shown as zero. |
| AC-12 | Accountant | Double-click Process for all | One payslip each | scale replay | **Pass** (0 duplicates). |

## HR

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| HR-01 | HR | Find anyone among 1,000+ | Fast search | scale | **Pass** (0.3 s list, instant search). |
| HR-02 | HR | 100 new hires at once | Bulk onboarding | = SC-10 | **Built** |
| HR-03 | HR | Offboard many at once | Bulk separation | E2E `95` (single), code | **Built.** User Management → Offboard many (ID + last day per line, one reason). |
| HR-04 | HR | Approve several branch runs | Approve selected | E2E sweep | **Pass** |
| HR-05 | HR | Many pending requests | Nothing lost, lists bounded | scale + unit | **Fixed.** Leave lists read at most 1,000 rows: older **pending** requests vanished from HR's queue, and payroll could miss approved leave filed ahead. Now every pending request, decided ones of 12 months, payroll by date overlap. |
| HR-06 | HR | Tenure Pay Protection for many | Grants listed with dates | E2E `50` | **Pass** (grants and breaks dated; license expiry alerts). |
| HR-07 | HR | Audit a decision 3 years old | Who, when, why | E2E `95` | **Fixed** (= SA-03; decisions also keep who/when/why on their own rows). |
| HR-08 | HR | Record moves between branches | History kept | E2E `50` | **Pass** |
| HR-09 | all | Salary / personal data privacy | Only who needs it | E2E `10` | **Pass** (API per role, RLS no client access, government IDs encrypted; export leaves them out). |
| HR-10 | HR | Mass card replacement, lost cards | Bulk, lost never reused | code | **Built** (Many cards → Replace, "old cards lost"). |
| HR-11 | HR / SA | Terminals offline | Last seen visible | E2E sweep | **Pass** (RFID Terminals show the last tap). |

## Admin (branch)

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| AD-01 | Admin | 150+ staff, who is late / absent today | Fast daily view | scale | **Fixed** (failed "URI too long" at 300 people; now 0.07 s). |
| AD-02 | Admin | Many endorsements a day | Workable lists | E2E sweep | **Pass** (search, tabs; one decision each). |
| AD-03 | Admin | Report and track an incident | Status visible | E2E `40` | **Pass** |
| AD-04 | Admin | Another branch's data | Blocked | E2E `10`, `50` | **Pass** |
| AD-05 | SA / HR | Branch closes or merges | People moved, history kept | code | **Built.** An inactive branch already refuses new hires; Transfer Requests → Move many moves a list of people at once, each in Transfer History. |

## Super Admin

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| SA-01 | SA | New branch | Works with no code change | E2E `95` | **Pass** |
| SA-02 | SA | Role change (HR → Accountant) | Takes effect at once, history | E2E `95` | **Pass** (at once the old role is refused, 403; within 5 s the session itself is ended, 401; audited). |
| SA-03 | SA | Audit log with millions of rows | Searchable | = SC-05 | **Fixed** |
| SA-04 | SA | Backup, restore, migration safety | Documented and guarded | docs + unit | **Pass** (backup/restore guide, tested restore, clean-reset guard, migration-name rule; both new migrations replayed on a fresh database). |
| SA-05 | SA | Process payroll / manage employees | Blocked | E2E `10` | **Pass** |
| SA-06 | SA | Schedule / cutoff / rate changes | Apply to the right periods | E2E `70` | **Pass** (future periods only; effective-dated rates). |

## Cross-cutting

| ID | Role | Situation | System must | How tested | Status |
| --- | --- | --- | --- | --- | --- |
| X-01 | HR | Two people edit one employee | No silent overwrite | E2E `95`, unit | **Fixed** (the later save gets 409 "changed after you opened it"). |
| X-02 | all | Network drops mid-submit | No duplicates | scale replay, E2E | **Pass** (payroll writes are atomic and idempotent per employee and period). |
| X-03 | all | Session expires with a form open | Input not lost | unit | **Fixed.** Typing never reached the server, so a long form idled out under the person filling it. Real input now renews the session (at most once a minute; 8-hour cap stays). |
| X-04 | HR | Approve twice (double-click) | One transition | E2E `95` | **Pass** (one approval, the other 409). |
| X-05 | SA / HR | School-year rollover | New year, old data intact | code review | **Pass** (subsidy and tenure years are dated; schedules effective-dated; nothing is reset). |
| X-06 | SA | Holiday / suspension mid-month | Attendance and pay follow | unit `holidays` | **Pass** |
| X-07 | all | Manila dates and boundaries | Right day | unit | **Pass** |
