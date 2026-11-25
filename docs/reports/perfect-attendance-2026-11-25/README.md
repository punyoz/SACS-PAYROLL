# Perfect Attendance paid automatically: test results (2026-11-25)

Owner decision: Perfect Attendance is paid automatically from attendance on both halves, shown to HR, and HR can undo it with a reason.
An undo made after the payslip was processed comes off the next payslip as a labelled adjustment. The shared ₱90,000 tax-free ceiling is respected.
Early Bird is unchanged (HR still approves it). **Not released**: branch `feat/perfect-attendance-auto-2026-11-25`, migration `20261126080000_perfect_attendance_automatic.sql`.

## How it works
- From the pay period in the setting `automation.perfect_attendance_auto_from` (proposed **2026-12-01**, the first unprocessed period), payroll records each cutoff's Perfect Attendance as approved by "System (attendance)" and pays it. A run no longer waits for HR on it. Periods before that date keep the current rule.
- HR → Approvals → Incentives & cash advances → **Decided** shows it as "Paid automatically", with an **Undo** button (a reason is required; never your own).
- Undo **before** the payslip is processed: it is simply not paid. Undo **after**: the processed payslip stays exactly as it was, and an approved, non-taxable adjustment "Perfect attendance undone (period)" takes the amount back on the next payslip, as its own line under Deductions → Other.
- Tax: Perfect Attendance stays a tax-free "other benefit" within the ₱90,000 yearly ceiling it shares with the 13th month (and the subsidy, when its treatment is "other benefit"). An undone amount counts back in that ledger.
- Example of the ceiling: with ₱89,800 already used this year, a ₱500 Perfect Attendance is ₱200 tax-free and ₱300 taxable.

## Real screens, fake local data (e2e/proof/perfect-attendance.spec.mjs)
A fake teacher "Paz Proof" (₱30,000) taps in on time every working day of December. Dec 1-15 was processed on a moved local date (Dec 16), HR undid its Perfect Attendance, and Dec 16-31 was processed on Jan 2.
The database clock cannot be moved, so the undo's adjustment was dated Dec 16 (the simulated day), as it would be in real use.

| Check | Expected | Actual | Result | Working |
|---|---|---|---|---|
| December 1-15, 2026: nothing waits for HR before submitting | 0 | 0 | **PASS** | Perfect Attendance is paid automatically |
| Dec 1-15: Perfect Attendance on the payslip | 500 | 500 | **PASS** | full attendance, rate ₱500 |
| Dec 1-15: recorded as paid by the system | approved / System (attendance) | approved / System (attendance) | **PASS** | no HR approval needed |
| Undo after processing: a labelled adjustment for the next payslip | Perfect attendance undone (December 1-15, 2026) / -500 / non-taxable / approved | Perfect attendance undone (December 1-15, 2026) / -500 / non-taxable / approved | **PASS** |  |
| The processed Dec 1-15 payslip is unchanged | 500 | 500 | **PASS** | never alter a processed payslip |
| December 16-31, 2026: nothing waits for HR before submitting | 0 | 0 | **PASS** | Perfect Attendance is paid automatically |
| Dec 16-31: its own Perfect Attendance on the payslip | 500 | 500 | **PASS** | paid automatically |
| Dec 16-31: the undone Dec 1-15 amount taken back | -500 | -500 | **PASS** | the approved adjustment |
| Dec taxable income leaves out both Perfect Attendance and the take-back | 27550 | 27550 | **PASS** | ₱30,000 − contributions (other benefits are tax-free under the ₱90,000 ceiling) |
| ₱90,000 ledger: Perfect Attendance kept for December | 500 | 500 | **PASS** | ₱500 + ₱500 paid − ₱500 taken back |

The Dec 16-31 payslip adds up: gross ₱22,396.55 − deductions ₱3,957.55 (including "Perfect attendance undone (December 1-15, 2026) ₱500") = net ₱18,439.00.

## Also fixed (found by this test)
A negative Additional Pay item (an undo, or a past "Adjustment") was left out of the 2nd-half payslip's lines and gross, while the net counted it, so the payslip did not add up. It is now its own deduction line. Live has no such item today (checked read-only), so no stored payslip is affected.

## Tests
- Unit: tests/incentive-recommendations.test.js (17, including 6 new).
- Database: scripts/checks/perfect-attendance-undo-scenarios.sql (8 PASS: only HR, a reason is required, Early Bird is not undone this way, after processing → adjustment and the processed payslip unchanged, the ceiling ledger counts it back, only once, before processing → not paid, never your own).
- Full unit suite 1714/0, `next build` OK.
- Rollback: scripts/rollback/rollback-2026-11-26-perfect-attendance.sql, tested locally (apply → rollback → re-apply, stored payslips unchanged). It refuses once an undo adjustment exists.

## Screenshots
| File | Shows |
|---|---|
| payslip-dec-1-15.png | Dec 1-15: Perfect attendance ₱500 paid automatically (no HR step) |
| hr-list-paid-automatically.png | HR's Decided list: "Paid automatically", with Undo |
| hr-undo-dialog.png | the Undo dialog with the reason |
| payslip-dec-16-31.png | Dec 16-31: its own Perfect attendance ₱500 and "Perfect attendance undone (December 1-15, 2026)" ₱500 under Deductions → Other |
