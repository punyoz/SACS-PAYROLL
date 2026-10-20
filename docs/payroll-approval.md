# Payroll Approval (HR)

Status (October 14, 2026): built on branch `feat/employee-schedules-cutoffs-early-bird`,
**not yet applied to the live database or deployed**.

Migration: `supabase/migrations/20261014010000_payroll_run_approval.sql`.

## Workflow

1. The Accountant processes each branch's payslips for a cutoff (1–15 or 16–end), as today.
2. **Submit for HR Approval** (Process Payroll page). The server snapshots every
   employee's computation; the run is **Pending HR Approval** and locked.
3. HR → **Payroll Approval** reviews each branch's run.
4. **Approve:** locked for good, the period's Early Bird winner is locked, and
   employees see their payslips. **Reject** (a reason is required): the run goes
   back to the Accountant; nothing is cleared. The Accountant **Reprocesses** the
   payslips to correct them and **resubmits**.

| From | To | Who | Function |
|---|---|---|---|
| Draft | Pending | Accountant (own branch) | `submit_payroll_run` |
| Pending | Approved | HR, not the person who processed or submitted it | `approve_payroll_run` |
| Pending | Rejected | HR, with a reason | `reject_payroll_run` |
| Rejected | Pending | Accountant (resubmit) | `submit_payroll_run` |

Any other move is refused by the database (trigger `payroll_runs_guard`), whoever asks.

## Changes of October 20, 2026 (`20261020010000_role_separation.sql`)

- Only the Accountant processes, generates and submits payroll; the Super
  Admin no longer can (no override either) and does not see payroll runs.
- The Accountant's own payslip is processed on the system-computed path only
  (Generate / Process payroll for all; no typed values), marked
  `payroll.own_payslip`, and flagged "Accountant's own payslip" for HR, who
  approves it with the run.
- After the generation window closes, the Accountant still processes missing
  payslips while the branch's run is Draft or Rejected; they are marked
  `payroll.late_processing` and flagged "Processed after the generation window".
- HR → Payroll Approval → **History** lists every approve / reject decision for
  good (`GET /api/hr/payroll-runs?view=history`).
- Payroll Records / Monitoring status: Not submitted to HR · Pending HR Approval ·
  Rejected by HR · Paid ("Paid" only once HR approved the run).

## Run the migrations in this order

1. `20261013010000_employee_schedules_cutoffs_early_bird.sql` (schedules, cutoffs, Early Bird)
2. `20261014010000_payroll_run_approval.sql` (this feature)

Test both on a local replay first (`docs/local-migration-replay.md`), then run
`scripts/checks/employee-schedules-scenarios.sql` and
`scripts/checks/payroll-run-approval-scenarios.sql` there. Each rolls itself back
and ends with "… scenarios passed". Then apply both to the live project, in the
same order, and deploy.

## What was reused, and what is new

Checked against the live schema on October 14, 2026.

| Existing | How it is used |
|---|---|
| `payroll_entries` | The processed payslips. A run groups them by `branch_id` (already stamped by trigger) + `pay_period`. New column `run_id`. Approval fills the existing, until now unused, `approved_by` / `approved_at`. |
| `payroll_state` enum (`pending_approval`, `approved`, `rejected`) | Not used: those are per payslip; approval is per branch run. |
| `payroll_records` | Unchanged; locked with its run. |
| `early_bird_winners` | Now locks when the period's first run is **approved** (it used to lock on the first Final payslip). |
| `audit_logs` | Every action: who (`actor_id`, `actor_name`), role (`actor_role`), action, run, time, remarks. |
| `private.has_permission` / `can_reach_branch` / `current_role_name` | The RLS policies. |
| `supabase_realtime` publication (was empty) | `payroll_runs` added. |

New: `payroll_runs`, `payroll_run_items` (the snapshot: columns plus a JSONB
`breakdown`), `payroll_approval_history`, `notifications` (there was none), the
view `payroll_run_summaries`, and the functions `ensure_payroll_run`,
`submit_payroll_run`, `approve_payroll_run`, `reject_payroll_run` and
`payroll_pending_run_count`.

## How the rules are enforced

- **Server routes:** `src/proxy.js` and `requirePermission()` read module
  `payroll_run_approval`:
  - HR: read every branch, update (approve / reject).
  - Super Admin: read only.
  - Accountant: read its own branch; it submits through `process_payroll`.
  - The approve / reject route also requires the HR role.
- **Database functions:** each takes the signed-in user from the session, checks
  that user's role in `profiles`, the status, and self-approval, then writes
  history, the audit row and the notifications.
- **Triggers (apply to the service role too):**
  - No payslip (`payroll_entries`, `payroll_records`) of a Pending or Approved run
    is created, changed, reprocessed or removed. That includes a Super Admin
    override.
  - Snapshots and history are append-only.
  - A run is never deleted.
- **RLS:** the policies the brief asks for are in place as the second line. As
  with every table since `20261012020000`, signed-in browsers hold no table
  grant: the app reads through its server routes only.
- **Employees:** from the October 1–15, 2026 period on, a payslip is shown only
  after its run is approved (`/api/employee/payslips`, and the RLS policy).
  Earlier periods are unaffected.

## Live updates

The browser has no Supabase session, and the site's Content-Security-Policy
allows connections to this site only. So:
- `/api/hr/payroll-runs/stream` subscribes to Supabase Realtime on the server and
  forwards "run X changed" to the page as Server-Sent Events.
- The HR list, the open run, and the sidebar badge refresh when an event
  arrives, every minute as a fallback, and when the window regains focus.

## Notes

- The two Oct 1–15, 2026 payslips already Final (test accounts) are hidden from
  those employees until that branch's run is approved.
- "Days worked", "Schedule used" (the employee's schedule on the period's last
  day) and "Level" are taken at submission and kept in the snapshot.
- **Highlighted rows:**
  - net pay below zero (paid ₱0, or carried over);
  - no days worked;
  - net pay more than 25% (and at least ₱1,000) away from the previous same cutoff.
- **Exports:**
  - Excel (`.xlsx`): Payroll, Lines and Summary sheets.
  - PDF: landscape, multi-page.
  - Print: the browser prints only the run.

## Test cases

`tests/payroll-run-approval.test.js` (Vitest, `npm test`) and
`scripts/checks/payroll-run-approval-scenarios.sql` (the real functions and
triggers, on a local replay).

| Case | Expected | Where |
|---|---|---|
| Accountant submits a run | Pending, totals from the rows, both HR accounts notified (bell, badge = 1) | Vitest "Accountant submits…"; SQL 3 |
| HR opens a run | Every employee's row with level, schedule, days, each line and the rates used; Early Bird winner shown | Vitest "HR opens the run…" |
| HR approves | Approved; payslips stamped; Early Bird winner locked; Accountant notified; the employee now sees the payslip | Vitest "HR approves…"; SQL 9 |
| Reject without / with a reason | 400 `remarks_required` and still Pending / Rejected, payslips kept, Accountant notified and sees the reason | Vitest "rejecting needs a reason…"; SQL 5–6 |
| Accountant edits a Rejected run and resubmits | Reprocess replaces the payslip (old record archived); resubmit → Pending, snapshot 2; history submitted → rejected → resubmitted | Vitest "rejecting needs a reason…"; SQL 7 |
| Accountant edits a Pending / Approved run | Generate, Reprocess, Save draft, Process for All, Super Admin override → 409 `payroll_run_locked`; the database refuses it too | Vitest "an Accountant cannot edit…", "HR approves…"; SQL 4, 10 |
| Accountant tries to approve | 403 from the proxy and the route; the database function refuses too | Vitest "an Accountant cannot edit… nor approve"; SQL 5 |
| A user approves a run they processed | 403 `self_approval`, still Pending | Vitest "nobody approves…"; SQL 8 |
| HR tries to change a computation | 403 on every payroll route; no editing action on its own route (400) | Vitest "HR cannot change a computation" |
| Totals match the rows | Run totals = sum of the employee rows (₱52,600 net) | Vitest "HR opens the run…" |
| Snapshot after changes | Attendance and the payslip change after submission; the run's figures do not | Vitest "the snapshot stays the same…"; SQL 4 |
| 1st vs 2nd cutoff | 1st: tax, SSS, PhilHealth, Pag-IBIG, loans all 0 (columns hidden); 2nd: absence, SSS 1,750, PhilHealth 1,305, Pag-IBIG 200, tax | Vitest "HR opens the run…", "a 2nd cutoff run…" |
| Early Bird on the run | Ben, 2 early time-ins, ₱500, "not locked" until approval, then locked | Vitest "HR opens…", "HR approves…" |
| HR approves two branches at once | One decision, two approvals, two history rows | Vitest "HR approves two branches at once" |
| Employee while Pending | The payslip is not listed | Vitest "HR approves…" (before approval) |
