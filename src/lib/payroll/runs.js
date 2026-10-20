/**
 * Payroll runs: one per branch per pay period, approved by HR
 * (supabase/migrations/20261014010000_payroll_run_approval.sql).
 *
 *   draft → pending → approved            (submit, approve)
 *           pending → rejected → pending  (reject, resubmit)
 *
 * The database functions enforce every move, the roles and self-approval;
 * this file shapes what the routes send them and read back:
 *
 *   shapeRunItem()   one employee's computation, from the processed payslip
 *                    (payroll_entries.payroll), as the snapshot HR approves.
 *                    submit_payroll_run() refuses it unless its gross,
 *                    deductions and net equal the payslip's.
 *   runTotals()      the run's totals: always the sum of its rows.
 *   isLockedRun()    Pending / Approved: nothing of the run may change.
 *   payslipVisible() whether an employee may see a payslip yet.
 */

import { roundPeso } from "@/lib/payroll/money";
import { periodFromLabel } from "@/lib/payroll/periods";

export const RUN_STATUSES = Object.freeze(["draft", "pending", "approved", "rejected"]);

// The four payroll labels, the same on every screen (2026-10-20): an
// approved run is what the Accountant, HR and the employee all call "Paid".
export const RUN_STATUS_LABELS = Object.freeze({
  draft: "Not submitted to HR",
  pending: "Pending HR Approval",
  approved: "Paid",
  rejected: "Rejected by HR",
});

/** StatusBadge tones: Draft gray, Pending amber, Approved green, Rejected red. */
export const RUN_STATUS_TONES = Object.freeze({ draft: "muted", pending: "warning", approved: "success", rejected: "danger" });

/** Pay periods starting on or after this reach employees only once approved. */
export const APPROVAL_EFFECTIVE = "2026-10-01";

/** A change of net pay this large against the employee's previous same cutoff is flagged. */
export const LARGE_CHANGE_RATIO = 0.25;
export const LARGE_CHANGE_MIN = 1000;

export const FLAG_LABELS = Object.freeze({
  negative_net: "Net pay below zero (paid ₱0)",
  zero_days: "No days worked",
  large_change: "Large change vs. previous period",
  own_payslip: "Accountant's own payslip (system-computed): check it",
  late_processing: "Processed after the generation window",
});

const peso = (value) => roundPeso(value);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function requiresApproval(periodLabel) {
  const period = periodFromLabel(periodLabel);
  return Boolean(period && period.start_key >= APPROVAL_EFFECTIVE);
}

export function isLockedRun(run) {
  return run?.status === "pending" || run?.status === "approved";
}

export function isEditableRun(run) {
  return !run || run.status === "draft" || run.status === "rejected";
}

/** May an employee see this payslip? Older periods always; newer only once its run is approved. */
export function payslipVisible(periodLabel, runStatus) {
  return !requiresApproval(periodLabel) || runStatus === "approved";
}

/** "October 1-15, 2026" → the same cutoff of the month before ("September 1-15, 2026"). */
export function previousSameCutoffLabel(periodLabel) {
  const period = periodFromLabel(periodLabel);
  if (!period) return null;
  const [year, month, day] = period.start_key.split("-").map(Number);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const last = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  return day === 1 ? `${names[prevMonth - 1]} 1-15, ${prevYear}` : `${names[prevMonth - 1]} 16-${last}, ${prevYear}`;
}

/** Rows HR should look at: net below zero, no day worked, or a big swing. */
export function attentionFlags({ grossPay, totalDeductions, netPay, carryOverOut = 0, daysWorked, previousNet }) {
  const flags = [];
  if (peso(grossPay - totalDeductions) < 0 || num(carryOverOut) > 0) flags.push("negative_net");
  if (!(num(daysWorked) > 0)) flags.push("zero_days");
  if (previousNet !== null && previousNet !== undefined && num(previousNet) > 0) {
    const change = Math.abs(num(netPay) - num(previousNet));
    if (change >= LARGE_CHANGE_MIN && change / num(previousNet) > LARGE_CHANGE_RATIO) flags.push("large_change");
  }
  return flags;
}

/**
 * One employee's snapshot row from a processed payslip.
 *
 * @param {object} entry  a payroll_entries row (payroll JSON as stored)
 * @param {{ employeeLevel?: string|null, scheduleName?: string|null, previousNet?: number|null }} [context]
 */
export function shapeRunItem(entry, { employeeLevel = null, scheduleName = null, previousNet = null } = {}) {
  const payroll = (typeof entry.payroll === "string" ? JSON.parse(entry.payroll) : entry.payroll) || {};
  const t = payroll.totals || {};
  const d = payroll.deductions || {};
  const m = payroll.monthly || {};
  const counts = payroll.audit?.attendance?.counts || {};

  const absence = peso(t.absence_deduction);
  const late = peso(t.late_deduction);
  const undertime = peso(t.undertime_deduction);
  const halfDay = peso(t.half_day_deduction);
  const lwop = peso(t.leave_without_pay_deduction);
  const attendance = peso(absence + late + undertime + halfDay + lwop);
  const tax = peso(d.withholding_tax);
  const sss = peso(d.sss);
  const philhealth = peso(d.philhealth);
  const pagibig = peso(d.pagibig);
  const loans = peso(d.loan);
  const totalDeductions = peso(t.total_deductions);
  // Cash advances, a balance carried in, a subsidy offset: whatever else the
  // payslip deducted.
  const other = peso(Math.max(0, totalDeductions - attendance - tax - sss - philhealth - pagibig - loans));
  const totalIncentives = peso(t.total_incentives);
  const grossPay = peso(num(t.gross_pay) + totalIncentives);
  const netPay = peso(Math.max(0, num(t.net_pay)));
  const daysWorked = num(counts.attended_days);
  const rates = payroll.audit?.rates || {};
  const rate = (type) => (rates[type] ? num(rates[type].value) : null);

  return {
    entry_id: entry.id,
    employee_id: entry.employee_id,
    employee_name: entry.employee_name || "Employee",
    employee_code: entry.employee_code || null,
    employee_level: employeeLevel,
    schedule_name: scheduleName,
    payslip_no: entry.payslip_no || null,
    basic_pay: peso(payroll.basic_salary),
    gross_pay: grossPay,
    total_deductions: totalDeductions,
    net_pay: netPay,
    attendance_deduction: attendance,
    absence_deduction: absence,
    late_deduction: late,
    undertime_deduction: undertime,
    half_day_deduction: halfDay,
    leave_without_pay_deduction: lwop,
    withholding_tax: tax,
    sss,
    philhealth,
    pagibig,
    loans,
    other_deductions: other,
    early_bird_incentive: peso(t.early_bird_winner_incentive),
    total_incentives: totalIncentives,
    days_worked: daysWorked,
    absent_days: num(d.absences_days ?? counts.absent_days),
    late_days: num(d.late_days ?? counts.late_days),
    late_minutes: num(d.late_minutes ?? counts.late_minutes),
    undertime_minutes: num(d.undertime_minutes ?? counts.undertime_minutes),
    half_days: num(d.half_days ?? counts.half_days),
    previous_net_pay: previousNet === null || previousNet === undefined ? null : peso(previousNet),
    flags: [
      ...attentionFlags({ grossPay, totalDeductions, netPay, carryOverOut: m.carry_over_out, daysWorked, previousNet }),
      // The submitting Accountant's own payslip: HR is its independent check.
      ...(payroll.own_payslip?.processed_by_self ? ["own_payslip"] : []),
      ...(payroll.late_processing ? ["late_processing"] : []),
    ],
    // Everything the expanded row shows: each line with its quantity and rate.
    breakdown: {
      own_payslip: payroll.own_payslip || null,
      half: m.half || null,
      attendance_rule: m.rule === "per_cutoff" || m.attendance_rule === "per_cutoff" ? "per_cutoff" : m.rule || null,
      window: m.cutoff?.window || m.window || null,
      cutoff: m.cutoff || null,
      lines: payroll.audit?.lines || { deductions: [], incentives: [] },
      counts,
      rates: {
        daily: rate("daily"),
        hourly: rate("hourly"),
        working_days_per_year: rate("working_days_per_year"),
        late_minute_charge_pct: rate("late_minute_charge_pct"),
        late_days_per_absent: rate("late_days_per_absent"),
      },
      deduction_basis: payroll.generation?.deduction_basis || [],
      taxable_income: m.taxable_income ?? null,
      carry_over_out: num(m.carry_over_out),
      early_bird: payroll.early_bird || null,
      deviations: payroll.audit?.deviations || null,
      attendance_through: payroll.generation?.attendance_through || null,
      generated_by_name: payroll.generation?.generated_by_name || null,
    },
  };
}

/** A run's totals from its rows (the database computes the same sums). */
export function runTotals(items) {
  return (items || []).reduce((acc, item) => ({
    employees: acc.employees + 1,
    gross: peso(acc.gross + num(item.gross_pay)),
    deductions: peso(acc.deductions + num(item.total_deductions)),
    net: peso(acc.net + num(item.net_pay)),
  }), { employees: 0, gross: 0, deductions: 0, net: 0 });
}

/** A payroll_run_summaries / payroll_runs row as the screens use it. */
export function shapeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    branch_id: row.branch_id,
    branch_name: row.branch_name || null,
    period_label: row.period_label,
    period_start: String(row.period_start).slice(0, 10),
    period_end: String(row.period_end).slice(0, 10),
    cutoff_type: row.cutoff_type,
    status: row.status,
    status_label: RUN_STATUS_LABELS[row.status] || row.status,
    submission_no: Number(row.submission_no) || 0,
    processed_by: row.processed_by || null,
    processed_by_name: row.processed_by_name || null,
    submitted_by: row.submitted_by || null,
    submitted_by_name: row.submitted_by_name || null,
    submitted_at: row.submitted_at || null,
    reviewed_by_name: row.reviewed_by_name || null,
    reviewed_at: row.reviewed_at || null,
    remarks: row.remarks || null,
    total_employees: Number(row.total_employees) || 0,
    total_gross: peso(row.total_gross),
    total_deductions: peso(row.total_deductions),
    total_net: peso(row.total_net),
    flagged_employees: Number(row.flagged_employees) || 0,
  };
}

/** The runs of these branches for one period: Map branchId -> run row. */
export async function loadRunsFor(supabase, branchIds, periodLabel) {
  const runs = new Map();
  const ids = [...new Set((branchIds || []).filter(Boolean).map(String))];
  if (!ids.length || !periodLabel) return runs;
  const result = await supabase.from("payroll_runs").select("*").in("branch_id", ids).eq("period_label", periodLabel);
  if (result.error) return runs; // migration not applied: nothing is locked
  (result.data || []).forEach((row) => runs.set(String(row.branch_id), row));
  return runs;
}

/** The refusal a locked run gives (null when the run may change). */
export function lockedRunMessage(run) {
  if (!isLockedRun(run)) return null;
  return run.status === "pending"
    ? `This branch's ${run.period_label} payroll is waiting for HR approval and cannot be changed. HR can reject it to reopen it.`
    : `This branch's ${run.period_label} payroll is approved and locked.`;
}

/** A database error message → { status, code, error } for the API. */
export function describeRunError(error) {
  const text = String(error?.message || error || "");
  const [code] = /^[a-z_]+(?=:)/.exec(text) || [];
  const message = text.replace(/^[a-z_]+:\s*/, "") || "The payroll run could not be updated.";
  const status = code === "forbidden" || code === "self_approval" ? 403
    : code === "not_found" ? 404
      : code === "invalid_period" ? 400
        : 409;
  return { status, code: code || "payroll_run_error", error: message };
}
