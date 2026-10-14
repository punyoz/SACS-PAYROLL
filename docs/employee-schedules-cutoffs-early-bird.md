# Employee Schedules, Cutoff Deductions, Leave Notice, Early Bird

Status (October 13, 2026): built on branch `feat/employee-schedules-cutoffs-early-bird`,
**not yet applied to the live database or deployed**.

Migration: `supabase/migrations/20261013010000_employee_schedules_cutoffs_early_bird.sql`.

## 1. Per-employee work schedules

Super Admin → System Configuration → Attendance keeps the branch schedule card
and adds **Employee work schedules** and **Early Bird incentive**. HR has the
same screens, with the same full power, under **Work Schedules** in its
sidebar. Admin sees them read-only for its own branch.

| Role | Schedules | Enforced by |
|---|---|---|
| Super Admin, HR | Create, edit, delete and assign profiles; set employee levels | `work_schedules` create / update (`src/lib/rbac/permissions.js`) |
| Admin | View own branch | The proxy and the route both answer 403 to any change |
| Accountant, Employee | None | 403 |

"Delete" archives the profile from a date: it stops being offered or
followed, and its history stays (no hard deletes in this system). A profile
still assigned to an employee or a level cannot be deleted until it is
reassigned.

| Piece | Where |
|---|---|
| Schedule profiles (name, start, end, grace, required hours, working days) | `work_schedules`: one row per version; a profile's versions share `schedule_key` |
| Employee level (Pre-school, Grade School, High School, Senior High School, Non-teaching) | `profiles.employee_level` |
| An employee's own schedule, or a level's schedule, from a date | `work_schedule_assignments` |
| The schedule a day is judged on | `attendance_schedule_for(employee, branch, day)` |

**Priority:** (1) the employee's own schedule, (2) their level's schedule,
(3) their branch schedule, (4) the default schedule. An assignment with no
schedule ("No own schedule") hands the employee back to the next level.

**Effective dates.** Every change (a new profile, an edited profile, a
delete, an assignment) takes effect from a date that is today or later
(Manila). Both tables are append-only: the database refuses an edit, a delete
or a past date. A day is always judged on the version in force on that day,
so attendance already recorded and payslips already issued never change.

**Where it is used.**

| | |
|---|---|
| RFID Time In / Out | The status engine (`attendance_logs_compute_status`) judges Late, Undertime, Half Day and Early Bird on the employee's own start, end, grace and required hours. Each row keeps the shift it was judged on (`shift_start_minutes`, `shift_end_minutes`) and the arrival offset. |
| Absent | The nightly close (`attendance_close_days`) uses the employee's working days: a Mon–Sat schedule is Absent on an untapped Saturday, a Mon–Fri one never is. |
| Timesheets | Each day shows the employee's own shift (the profile's name), tardiness and undertime. |
| Payroll | Deductions come from those rows, priced at the employee's own daily / hourly rate. |

**Audit.** Every change is in Audit & Monitoring (module `work_schedules`:
`schedule_create`, `schedule_update`, `schedule_delete`,
`schedule_assign_employee`, `schedule_assign_level`, `employee_level_update`),
with who, their role (`actor_role`, and "by Name (HR)" in the description),
when, the effective date and the before / after values.

**Known limit.** The employee level itself has no effective date: changing it
moves the employee to the new level's schedule for days judged from then on.
Days already recorded keep the status they were given. Give an employee their
own schedule (which is effective-dated) when the exact date matters.

## 2. Semi-monthly deductions, per cutoff

From the October 1–15, 2026 payslip:

| Payslip | Pays | Deducts |
|---|---|---|
| 1st cutoff (1–15) | Monthly salary ÷ 2, plus this cutoff's overtime, holiday pay and Early Bird incentive | **Attendance only:** absences, leave without pay, late, undertime, half days of its own days. No tax, SSS, PhilHealth, Pag-IBIG, loans or other deductions. |
| 2nd cutoff (16–end) | Monthly salary ÷ 2, plus its own earnings and the month's incentives / overload / subsidy | Its own attendance, **SSS, PhilHealth, Pag-IBIG, withholding tax, loans, cash advances and any carried balance**, each on its own line |

Withholding tax and contributions are worked out on the **whole month's**
earnings, using the existing monthly tax table and contribution settings:

```
Month's taxable = monthly salary − (1st + 2nd cutoff attendance)
                  + both cutoffs' extra earnings − contributions
2nd cutoff net  = Rate − its attendance + its earnings − SSS − PhilHealth − Pag-IBIG − tax − loans − other
```

**Which days each cutoff counts.** A day still in progress cannot be judged,
so each cutoff reads attendance up to the day before its payslip's generation
day (the existing payslip schedule), and that day moves to the next cutoff.
No day is counted twice or skipped. With the default schedule:

| Payslip | Generated | Attendance counted |
|---|---|---|
| Oct 1–15, 2026 | Thu Oct 15 | Oct 1 – Oct 14 |
| Oct 16–31, 2026 | Fri Oct 30 | Oct 15 – Oct 29 |
| Nov 1–15, 2026 | Mon Nov 16 | Oct 30 – Nov 15 |

**October 2026.** Two Oct 1–15 payslips were already Final under the old rule
(full Rate, nothing deducted). For those two employees the Oct 16–31 payslip
still settles the whole month, so their Oct 1–14 attendance is not lost. Every
other employee follows the new rule.

`payroll_entries.cutoff` (`first` / `second`) is stamped from the period label.

## 3. Leave: 7 days ahead

The start date must be at least 7 days after the submission date (Manila).
Filed Oct 13, 2026: the earliest start is Oct 20. The date picker disables
earlier days, and `POST /api/employee/leave-requests` refuses an earlier start
with *"Leave requests must be submitted at least 7 days before the leave start
date."* The submission date and time are saved (`leave_requests.submitted_at`).
The approval flow is unchanged. The rule covers every leave type, sick and
emergency leave included.

## 4. Early Bird incentive

| Rule | Detail |
|---|---|
| Early time-in | At least the **threshold** (default 15 min, Super Admin or HR) before the employee's **own** start that day. 8:00 start: 7:45 counts, 7:46 does not. |
| Counted over | The cutoff's own attendance days (section 2). |
| Winner | One per pay period: the most early time-ins. Tie-breakers: earliest average arrival against their own start, then fewest late days, then fewest absences. A complete tie goes to the lower employee ID, and the winner record says so. |
| Eligible | At least one early time-in. With **Unexcused absence makes ineligible** on (default; a switch Super Admin or HR can flip), no Absent day in the period. Approved leave is On Leave, not Absent. |
| Amount | Super Admin or HR. **₱0 (the default) switches the incentive off**: set an amount to start it. |
| Payslip | Earnings line **Early Bird Incentive**, part of gross pay and of the month's taxable income. Non-winners get no line. |
| Stored | `early_bird_winners`: period, employee, early count, average arrival, late / absent counts, amount, threshold, the early time-ins it was won with, the top five. |
| Locked | Worked out again each time payroll is generated, until HR approves the period's first payroll run (docs/payroll-approval.md). After that the database refuses any change. |
| Shown | The Accountant's Process Payroll page (another branch's winner is not named), the Early Bird card (Super Admin, HR, Admin), and the winner's own payslip. |

**The old per-day Early Bird bonus is retired.** This incentive is the only
Early Bird incentive:

- the `early_bird_bonus` rate is gone from System Configuration → Rates, and
  the database refuses new versions of it (its old rows stay as history);
- payroll no longer reads the rate or counts Early Bird days, so nothing can
  be paid twice (`src/lib/payroll/attendance-pay.js` has no early-bird line);
- new payslips have no "Early bird" line; the Accountant's form shows the
  period-winner incentive instead of an "Early bird (days)" field;
- payslips and payroll records that already paid it are not touched, and
  still show it ("Early Bird bonus (2d)") wherever they are opened.

On the live database no payslip ever paid it (the rate was ₱0).

## 5. Deploying

1. Replay the migration locally (`docs/local-migration-replay.md`), then run
   `scripts/checks/employee-schedules-scenarios.sql` on the local database. It
   rolls itself back and ends with `all employee schedule scenarios passed`.
2. Apply the migration to the live project.
3. Deploy the branch. The new screens show "not set up yet" until step 2 is done.
4. Super Admin or HR: create the schedule profiles, set each employee's level,
   assign schedules by level and per employee, and set the Early Bird amount.

## 6. Test cases

`tests/employee-schedules-cutoffs-early-bird.test.js` (Vitest, `npm test`) and
`scripts/checks/employee-schedules-scenarios.sql` (status engine, local
database). Salary in the payroll cases: ₱52,200 (daily ₱2,400, hourly ₱300,
Rate ₱26,100), late and undertime ₱5 a minute.

| # | Case | Expected | Where |
|---|---|---|---|
| 0 | HR changes an employee's schedule (allowed); a non-HR Admin tries (blocked) | HR assigns Cora the Pre-school schedule from Oct 14: saved, and logged as `schedule_assign_employee` with `actor_role` hr and "…, by hr (HR).". HR also creates, edits (new version) and deletes a profile. Admin (and Accountant) assign / delete / set level → **403** from the route and from the proxy; nothing written. HR changes the Early Bird threshold, eligibility and amount; Admin's change → 403. | Vitest: "HR changes an employee's schedule", "a non-HR Admin … blocked by the server", "Early Bird settings" |
| 1 | Two employees in the same branch with different schedules | Same branch: Ana follows Pre-school Teacher by level (7:30–12:30, grace 10), Ben his own Senior High schedule (8:00–17:00), Cora the branch / default | Vitest: "employees of one branch follow different schedules"; SQL check 1 |
| 2 | Pre-school vs Senior High teacher, same day, both tap 7:45 | Pre-school: Late 15 min (and 30 min undertime leaving at 12:00). Senior High: Early Bird, 15 min early. | SQL check 2 |
| 3 | A schedule change that starts mid-period | Change effective Oct 8: Oct 7 stays on 8:00 (Early Bird) even when recomputed; Oct 8 is judged on 7:30 (Late 15). A past effective date is refused. The screen shows the change as upcoming. | SQL checks 4 and 8; Vitest: "refuses an effective date before today", "own_upcoming" |
| 4 | 1st cutoff payslip (attendance only) | Ana: 26,100 − late 100 − undertime 150 = **25,850**; SSS, PhilHealth, Pag-IBIG, tax and loans all 0 | Vitest: "1st cutoff payslip" |
| 5 | 2nd cutoff payslip (all deductions) | Ana: lines Absences 2,400 · SSS 1,750 · PhilHealth 1,305 · Pag-IBIG 200 · Withholding tax 4,467.40 (month's taxable 46,295) → net **15,977.60** | Vitest: "2nd cutoff payslip" |
| 6 | Leave on day 6 / day 7 (filed Oct 13) | Oct 19 → 400 with the rule's message; Oct 20 → 201, pending, submission time saved | Vitest: "POST /api/employee/leave-requests" |
| 7 | Time-in exactly 15 min early / 14 min early | 7:45 (−15) counts; 7:46 (−14) does not; with the threshold set to 10, −14 counts | Vitest: "exactly 15 minutes…"; SQL checks 3 and 6 |
| 8 | Early Bird tie between two employees | Ana and Ben both have 2 early time-ins; Ben's average arrival is earlier (−7 vs −3.75 min), so Ben wins ₱500 and only his payslip has the line. Separate cases for late days, absences and a complete tie (lower employee ID). | Vitest: "Early Bird tie on count", "tie 1/2/3", "complete tie" |
| 9 | An employee with an unexcused absence | 9 early time-ins with 1 absence loses to 3 early time-ins with none; with the setting off, they win. In the payroll case Ana's Oct 19 absence (and a 14-minute early tap) leaves the 2nd cutoff with no winner. | Vitest: "an unexcused absence makes an employee ineligible", "2nd cutoff payslip" |
| 10 | A payslip with no old per-day bonus, and an old Final payslip that still shows it | The old ₱20 / day rate is still on file and Ben has two Early Bird days: his new Oct 1–15 payslip has no `early_bird` line or amount, only the ₱500 Early Bird Incentive. A Sept 16–30 Final payslip that paid ₱40 still shows "Early Bird bonus (2d)" ₱40, net ₱26,140, unchanged in the database. The rate can no longer be saved. | Vitest: "a new payslip has no per-day bonus…", "The per-day Early Bird bonus is retired" |
