/**
 * Cash advances (public.payroll_cash_advances), deducted in installments.
 *
 * An advance is deducted from every payslip it applies to (both halves, or
 * only the 1-15 / 16-end payslip), from its start period on, until it is
 * repaid:
 *
 *   Deduction = min(installment, balance, what the payslip can still pay)
 *   Balance   = principal − deductions on Final payslips
 *
 * Repayments are read from the Final payslips themselves
 * (payroll_entries.payroll.cash_advances), never stored apart, so a payslip
 * and its repayment cannot disagree: an overridden payslip replaces its own
 * repayment, and a Draft repays nothing until it is Final.
 *
 * "What the payslip can still pay" is its net pay before cash advances: an
 * advance never pushes net pay below zero; the unpaid part stays on the
 * balance for the next payslip.
 *
 * Example (Berlon, Jane Aira S.): installment ₱1,000, net before the advance
 * ₱4,400 → deducts ₱1,000, net ₱3,400.
 */

import { roundPeso } from "@/lib/payroll/money";

const peso = (value) => roundPeso(value);

export const CASH_ADVANCE_DEDUCT_ON = Object.freeze(["both", "first", "second"]);
export const CASH_ADVANCE_STATUSES = Object.freeze(["active", "on_hold", "cancelled"]);

function payrollOf(entry) {
  const payroll = entry?.payroll;
  if (typeof payroll === "string") {
    try { return JSON.parse(payroll); } catch { return null; }
  }
  return payroll || null;
}

/**
 * Repaid so far per advance, from Final payslips.
 *
 * @param {Array} entries  payroll_entries rows ({ pay_period, status, payroll })
 * @param {{ excludePeriod?: string }} [options]  leave out one period (the one being recomputed)
 * @returns {Map<string, number>} advance id -> amount repaid
 */
export function repaidByAdvance(entries, { excludePeriod = null } = {}) {
  const repaid = new Map();
  (entries || []).forEach((entry) => {
    if (String(entry?.status || "").toLowerCase() !== "paid") return;
    if (excludePeriod && entry.pay_period === excludePeriod) return;
    const lines = payrollOf(entry)?.cash_advances;
    if (!Array.isArray(lines)) return;
    lines.forEach((line) => {
      const id = String(line?.advance_id || "");
      if (!id) return;
      repaid.set(id, peso((repaid.get(id) || 0) + (Number(line.amount) || 0)));
    });
  });
  return repaid;
}

/** Principal less what Final payslips repaid, never below zero. */
export function advanceBalance(advance, repaid) {
  const paid = Number(repaid?.get?.(String(advance?.id)) || 0);
  return Math.max(0, peso(Number(advance?.principal || 0) - paid));
}

/** Whether an advance is deducted from a period's payslip. */
export function appliesToPeriod(advance, period) {
  if (!advance || advance.status !== "active") return false;
  const start = String(period?.start_key || "");
  if (!start || String(advance.start_date || "") > start) return false;
  const half = start.slice(8, 10) === "01" ? "first" : "second";
  return advance.deduct_on === "both" || advance.deduct_on === half;
}

/**
 * The installments one payslip deducts, oldest advance first.
 *
 * @param {object} args
 * @param {Array}  args.advances   the employee's payroll_cash_advances rows
 * @param {Map}    args.repaid     repaidByAdvance() for the other periods
 * @param {{ start_key: string }} args.period
 * @param {number} args.available  net pay before cash advances
 * @returns {{ lines: Array<{ advance_id: string, description: string|null, installment: number,
 *   due: number, amount: number, balance_before: number, balance_after: number }>, total: number }}
 */
export function scheduleCashAdvances({ advances, repaid, period, available }) {
  let room = Math.max(0, peso(available));
  const lines = [];
  [...(advances || [])]
    .filter((advance) => appliesToPeriod(advance, period))
    .sort((a, b) => String(a.date_granted).localeCompare(String(b.date_granted))
      || String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .forEach((advance) => {
      const balance = advanceBalance(advance, repaid);
      if (balance <= 0) return;
      const due = Math.min(peso(advance.installment_amount), balance);
      const amount = peso(Math.min(due, room));
      room = peso(room - amount);
      lines.push({
        advance_id: String(advance.id),
        description: advance.description || null,
        installment: peso(advance.installment_amount),
        due: peso(due),
        amount,
        balance_before: balance,
        balance_after: peso(balance - amount),
      });
    });
  return { lines, total: peso(lines.reduce((sum, line) => sum + line.amount, 0)) };
}

/** Validation for a new advance. Returns an error message, or null. */
export function validateCashAdvanceInput({ principal, installment_amount: installment, deduct_on: deductOn, date_granted: granted, start_date: start }) {
  const amount = Number(principal);
  const each = Number(installment);
  if (!(Number.isFinite(amount) && amount > 0 && amount <= 9999999.99)) return "Enter the amount advanced (more than 0).";
  if (!(Number.isFinite(each) && each > 0)) return "Enter the installment deducted per payslip (more than 0).";
  if (each > amount) return "The installment cannot be more than the amount advanced.";
  if (!CASH_ADVANCE_DEDUCT_ON.includes(String(deductOn || ""))) return "Choose which payslips deduct it.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(granted || ""))) return "Choose the date the advance was given.";
  if (!/^\d{4}-\d{2}-(01|16)$/.test(String(start || ""))) return "Choose the first pay period to deduct from.";
  return null;
}
