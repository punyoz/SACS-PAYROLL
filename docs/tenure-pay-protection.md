# Tenure Pay Protection

Some employees with long service have a contract clause: their pay is **not deducted** for absence, lateness, holiday work, suspensions, summer break or Christmas break. This feature records who has that clause and makes payroll honour it.

- Migration: `supabase/migrations/20261015010000_tenure_pay_protection.sql` (run after `20261014010000`)
- Payroll rules: `src/lib/payroll/tenure-protection.js`, applied in `computeAttendancePay` (`src/lib/payroll/attendance-pay.js`)
- API: `/api/hr/tenure-protection`
- Screen: HR → Employees → **Tenure Pay Protection** (also Admin → Payroll and Super Admin → Management)
- SQL checks: `scripts/checks/tenure-pay-protection-scenarios.sql`; tests: `tests/tenure-pay-protection.test.js`

## When a deduction is waived

All four must hold for the attendance day:

1. **The policy is active.** The branch's own policy applies if it has one, otherwise the system-wide policy.
2. **A grant is in force.** HR, an Admin or the Super Admin granted it to the employee, and `effective_from <= day < revoked_on`. Meeting the tenure never applies it by itself, because it rests on a signed contract.
3. **The employee has the tenure.** `date_hired` + the policy's minimum years (default 2) is on or before the day. Tenure is counted in whole months, and a Feb 29 hire reaches the anniversary on Feb 28.
4. **The policy covers the day's category.**

| The day is… | Category | Deductions waived on it |
|---|---|---|
| inside a summer break period | Summer break | all (absent, half day, late, undertime) |
| inside a Christmas break period | Christmas break | all |
| a whole-day or partial suspension | Suspension | all |
| a regular holiday or special day | Holiday | all (e.g. late on a worked holiday) |
| any other day | Absence | Absent, Half Day |
| any other day | Late | Late (per-minute charge, and the day does not count toward the N-late-days rule) |

A break, holiday or suspension day is judged **only** by its own category. With "Summer break" unchecked, summer days stay unpaid even if "Absence" is checked. Undertime on an ordinary day is not a covered category.

A waived absence, late or undertime still rules out Perfect Attendance. An Accountant's manual override of the counts is still an override.

Without protection, nothing changes. The nightly close marks untapped working days in a break as Absent, so break days stay unpaid as before.

## Data

| Table | Holds |
|---|---|
| `tenure_protection_policies` | One system-wide row (`branch_id` NULL), seeded at 2 years with every category covered, and optional per-branch rows. `use_global = true` sends a branch back to the system-wide row. |
| `tenure_protection_grants` | Employee, `effective_from`, notes (contract reference), granted by / role / at, and `revoked_on` / by / role / at / notes. Only one open grant per employee. |
| `school_break_periods` | Summer or Christmas break per school year (June–May), with start and end dates. Editable; "Remove" archives the row. |
| `tenure_protection_applications` | Every waived deduction: payslip (`entry_id`), period, employee, `grant_id`, category, deduction type, attendance log, date, quantity, amount. |

The payslip keeps the same lines in `payroll.audit.attendance.tenure_protection`, which is also copied to `payroll_records.attendance_snapshot`. A trigger on `payroll_entries` copies them into `tenure_protection_applications` whenever a payslip is saved. A regenerated draft replaces its rows. A problem in that trigger raises a warning and never blocks payroll.

SQL helpers (service role only): `tenure_protection_policy_for(branch)`, `tenure_meets_threshold(employee, day)`, `school_break_kind_on(day)`, `tenure_protection_grant_for(employee, category, day)`.

## Rules the database enforces

- Grants, policies and break dates can be written only by a user whose **profile** role is HR, Admin or Super Admin. The recorded role comes from the profile, never from the request.
- Grants go only to employees and accountants, can't start before today (Manila), are never edited or deleted, and are revoked once, from today or later.
- Policies and breaks are never deleted.
- `anon` and `authenticated` have no access to the tables or functions. The API (service role) applies the role matrix (`tenure_protection`, row 4b of `SACS-Payroll-Permission-Matrix.md`).

## Past payroll

Revoking sets `revoked_on` to today or a later date. Days before it keep their protection, even if a draft payslip is generated again. Final payslips are never recalculated. Policy and break-date changes take effect for payslips that aren't final yet.
