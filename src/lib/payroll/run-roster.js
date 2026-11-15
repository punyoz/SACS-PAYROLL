/**
 * Who a branch's payroll run is about, one definition for every screen
 * (decisions 2026-11-15): the run card, the batch table, the submission and
 * the Action needed panel all count with these. Pure: no database here.
 *
 *   expectedInRun()      the branch's active list for a period: paid staff,
 *                        not archived, not inactive, not on pay hold, hired
 *                        by the period's end.
 *   branchRoster()       that list against the period's payslips: processed
 *                        (Final), Drafts, left out, and Final payslips of
 *                        people outside the list (e.g. an archived account).
 *   firstHalfBasis()     what a 2nd half stores of the 1st half it used.
 *   firstHalfChange()    whether that 1st half has changed since ("Needs
 *                        recompute"), with the reason.
 */

import { floorNetPay } from "@/lib/payroll/net-pay";
import { PER_CUTOFF_RULE } from "@/lib/payroll/semi-monthly";

/** Why an employee is not in a run (payroll_run_exclusions.left_out_as). */
export const LEFT_OUT_AS = Object.freeze({ not_processed: "not_processed", draft: "draft", outside_list: "outside_list" });
export const LEFT_OUT_LABELS = Object.freeze({
  not_processed: "Not processed",
  draft: "Draft, not finalized",
  outside_list: "Not in this branch's active list",
});

const amount = (value) => Math.round((Number(value) || 0) * 100) / 100;
const pesoText = (value) => `₱${amount(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Employees a branch's run must contain: paid staff, active, not held, hired by the period's end. */
export function expectedInRun(staff, branchId, period) {
  return (staff || []).filter((person) => String(person.branch_id || "") === String(branchId || "")
    && !person.archived
    && String(person.employee_status || "active").toLowerCase() !== "inactive"
    && !person.payroll_hold
    && (!person.date_hired || String(person.date_hired).slice(0, 10) <= period.end_key));
}

/**
 * The branch's active list against the period's payslips.
 * @param {{ staff: object[], branchId: string, period: object, entries: object[] }} input
 *   entries: the period's payroll_entries of the branch (status draft | paid)
 */
export function branchRoster({ staff, branchId, period, entries }) {
  const active = expectedInRun(staff, branchId, period);
  const activeIds = new Set(active.map((p) => String(p.id)));
  const mine = (entries || []).filter((e) => String(e.branch_id || "") === String(branchId || ""));
  const finals = mine.filter((e) => e.status === "paid");
  const drafts = mine.filter((e) => e.status === "draft");
  const finalFor = new Set(finals.map((e) => String(e.employee_id)));
  return {
    active,
    // Active employees with a Final payslip ("X of Y processed").
    processed: active.filter((p) => finalFor.has(String(p.id))),
    drafts,
    // Active employees with no Final payslip; a Draft is left out too.
    missing: active.filter((p) => !finalFor.has(String(p.id))),
    // Final payslips of people not on the active list: in the run only when ticked.
    outside: finals.filter((e) => !activeIds.has(String(e.employee_id))),
    finals,
  };
}

/** The 1st-half figures a 2nd half was computed with (stored at payroll.monthly.first_half_basis). */
export function firstHalfBasis(firstEntry) {
  if (!firstEntry || firstEntry.status !== "paid") return null;
  const payroll = parsePayroll(firstEntry.payroll);
  const monthly = payroll.monthly || {};
  const perCutoff = Boolean(monthly.rule === PER_CUTOFF_RULE && monthly.window?.end_key);
  return {
    entry_id: firstEntry.id || null,
    version: firstEntry.updated_at || null,
    payslip_no: firstEntry.payslip_no || null,
    net_pay: floorNetPay(payroll.totals?.net_pay),
    attendance_deductions: perCutoff ? amount(monthly.attendance_deductions) : 0,
  };
}

/**
 * Has the 1st half changed since this 2nd half was computed?
 * @returns {null | { reason: string, old_net: number, new_net: number|null, difference: number }}
 *   difference: what the 2nd half now over- (> 0) or under- (< 0) pays.
 */
export function firstHalfChange(secondEntry, firstEntry) {
  const basis = parsePayroll(secondEntry?.payroll).monthly?.first_half_basis;
  if (!basis) return null; // computed before 2026-11-15, or with no Final 1st half
  const now = firstHalfBasis(firstEntry);
  if (!now) {
    return { reason: `1st half changed: its Final payslip ${firstEntry ? "is a Draft again" : "was removed"}`, old_net: amount(basis.net_pay), new_net: null, difference: 0 };
  }
  const parts = [];
  if (amount(now.net_pay) !== amount(basis.net_pay)) parts.push(`net ${pesoText(basis.net_pay)} → ${pesoText(now.net_pay)}`);
  if (amount(now.attendance_deductions) !== amount(basis.attendance_deductions)) {
    parts.push(`attendance deductions ${pesoText(basis.attendance_deductions)} → ${pesoText(now.attendance_deductions)}`);
  }
  if (!parts.length && basis.entry_id && now.entry_id && String(basis.entry_id) !== String(now.entry_id)) parts.push("its payslip was replaced");
  if (!parts.length) return null;
  return {
    reason: `1st half changed: ${parts.join(", ")}`,
    old_net: amount(basis.net_pay),
    new_net: amount(now.net_pay),
    // The month settles against the 1st half paid: a larger 1st half means the 2nd half paid too much.
    difference: amount(now.net_pay - basis.net_pay),
  };
}

/** "November 16-30, 2026" → "November 1-15, 2026"; null for a 1st half. */
export function firstHalfLabelOf(periodLabel) {
  const match = /^([A-Za-z]+) (\d+)-(\d+), (\d{4})$/.exec(String(periodLabel || "").trim());
  if (!match || match[2] === "1") return null;
  return `${match[1]} 1-15, ${match[4]}`;
}

function parsePayroll(payroll) {
  if (!payroll) return {};
  if (typeof payroll === "string") {
    try { return JSON.parse(payroll) || {}; } catch { return {}; }
  }
  return payroll;
}
