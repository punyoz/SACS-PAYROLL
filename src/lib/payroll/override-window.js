/**
 * When the Accountant may override an attendance-derived value (Absent, Late,
 * Undertime, Half day, Leave without pay and Perfect attendance) on the
 * Process Payroll form (2026-11-03, professor's feedback: overrides only on
 * the processing date; Leave without pay added by the user's decision the
 * same day: it deducts at the daily rate like an absence).
 *
 * The window dates are the Super Admin's (System Configuration -> Payslip
 * Schedule, window_days a setting); HR sees them read-only. There is no
 * "reopen" button: HR reopens a run only by rejecting it, with a reason.
 *
 * The processing window is the one payslips are generated in: the payslip
 * schedule's generation day to closes_on (Super Admin -> Payslip Schedule,
 * public.payroll_schedule_settings, effective-dated per half;
 * src/lib/payroll/schedule.js). Without a schedule it is the original
 * window: the period's last day to the pay date.
 *
 * An override is allowed only when ALL of these hold:
 *   - today is inside the period's processing window, or HR rejected the
 *     employee's run back to the Accountant (that run only, any date);
 *   - the employee's payroll for the period is still open: no Final payslip
 *     yet, or a Final payslip in a run HR rejected; and the run is not
 *     Pending HR approval or Approved;
 *   - the employee is in the Accountant's own branch (the route only lists
 *     those; `sameBranch` says so).
 *
 * The API (src/app/api/accountant/payroll/route.js) enforces this whatever
 * the portal shows; the portal calls the same function to lock the fields.
 * The Super Admin's override of an approved Final payslip
 * (action "override_final") is separate and unchanged.
 */

import { formatDateKey } from "@/lib/payroll/generation-window";

/** The form fields an attendance override changes (deviation field names). */
export const ATTENDANCE_OVERRIDE_FIELDS = Object.freeze(["absences_days", "late_days", "undertime_minutes", "half_days", "leave_without_pay_days", "perfect_attendance"]);

/** The attendance overrides among a payroll's deviations ([{ field, default, value }]). */
export function attendanceOverrides(deviations) {
  return (deviations || []).filter((item) => ATTENDANCE_OVERRIDE_FIELDS.includes(item?.field));
}

/** The window's first and last day ("YYYY-MM-DD"); null when unknown. */
export function processingWindowRange(window) {
  if (!window) return null;
  const opens = window.opens_on || window.generation_date || null;
  // Scheduled: the generation window; otherwise it stays open to the pay date.
  const closes = window.scheduled ? window.closes_on || opens : window.pay_date || window.period_end || opens;
  return opens ? { opens_on: opens, closes_on: closes } : null;
}

/** "Nov 16 to Nov 20" (year shown when the window crosses into a new year). */
export function processingWindowLabel(window) {
  const range = processingWindowRange(window);
  if (!range) return "the processing window";
  const short = (key) => formatDateKey(key).replace(/, \d{4}$/, "");
  const sameYear = range.opens_on.slice(0, 4) === range.closes_on.slice(0, 4);
  return sameYear
    ? `${short(range.opens_on)} to ${short(range.closes_on)}`
    : `${formatDateKey(range.opens_on)} to ${formatDateKey(range.closes_on)}`;
}

/** True when `today` (Manila "YYYY-MM-DD") is inside the processing window. */
export function insideProcessingWindow(window, today = window?.today) {
  const range = processingWindowRange(window);
  if (!range || !today) return false;
  return today >= range.opens_on && today <= range.closes_on;
}

/**
 * @param {object} args
 * @param {object} args.window         generationWindow() for the period
 * @param {string|null} args.runStatus the employee's governing run: draft | pending | approved | rejected | null
 * @param {string|null} args.payslipStatus "final" when a Final payslip exists, else draft / null
 * @param {boolean} [args.sameBranch]  the employee is in the Accountant's branch
 * @param {string} [args.today]        Manila date; defaults to the window's
 * @returns {{ allowed: boolean, code: string|null, message: string, reopened: boolean, window_label: string }}
 */
export function attendanceOverrideState({ window, runStatus = null, payslipStatus = null, sameBranch = true, today } = {}) {
  const label = processingWindowLabel(window);
  const result = (allowed, code, message, reopened = false) => ({ allowed, code, message, reopened, window_label: label });
  if (!sameBranch) {
    return result(false, "override_other_branch", "Overrides are only for employees of your own branch.");
  }
  if (runStatus === "pending") {
    return result(false, "override_run_submitted", "Overrides are closed: this payroll was submitted to HR for approval. HR can reject it to reopen overrides.");
  }
  if (runStatus === "approved") {
    return result(false, "override_run_approved", "Overrides are closed: this payroll was approved by HR and is final.");
  }
  // HR sent the run back: overrides reopen for that run only, on any date.
  if (runStatus === "rejected") {
    return result(true, null, "HR returned this payroll run: overrides are reopened for this run until it is submitted again.", true);
  }
  if (payslipStatus === "final") {
    return result(false, "override_payslip_final", "Overrides are closed: this employee's Final payslip is already generated. They reopen only if HR rejects the run.");
  }
  if (!insideProcessingWindow(window, today ?? window?.today)) {
    return result(false, "override_outside_window", `Overrides are only available during the processing window (${label}).`);
  }
  return result(true, null, `Processing window open (${label}): an override needs a reason and is logged.`);
}
