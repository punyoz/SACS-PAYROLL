/**
 * Loan limit (2026-11-25, 20261125010000): an employee cannot owe more on
 * loans than their salary. There is no other limit.
 *
 *   limit = monthly basic salary in force today × multiplier (default 1.0)
 *   owed  = remaining balance of every unpaid loan, pending or approved
 *   room  = limit − owed; a new loan's total payable (with interest) must fit.
 *
 * Counted and checked: salary, emergency and "other" loans. Not counted:
 * cash advances (own cap), subsidy advances, overpayment recoveries.
 * The database is the rule (payroll_loans_salary_limit_guard): it checks
 * every create, upward edit and HR approval. This file shows the same
 * numbers on the forms and words the refusal.
 * Settings (pending policy manual): system_config payroll.loan_limit_*.
 */

import { roundPeso } from "@/lib/payroll/money";

export const LOAN_LIMIT_TYPES = Object.freeze(["salary_loan", "emergency_loan", "other"]);
export const LOAN_LIMIT_DEFAULTS = Object.freeze({ basis: "basic_monthly", multiplier: 1 });
export const LOAN_LIMIT_BASIS_LABELS = Object.freeze({ basic_monthly: "Monthly basic salary in effect today" });
export const LOAN_LIMIT_MULTIPLIER_RANGE = Object.freeze({ min: 0.1, max: 12 });

const peso = (value) => roundPeso(value);
const money = (value) => `₱${peso(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function isLimitedLoanType(type) {
  return LOAN_LIMIT_TYPES.includes(String(type || ""));
}

/** "1 month's salary", "1.5 months' salary". */
export function multiplierText(multiplier) {
  const m = Number(multiplier) || 1;
  return m === 1 ? "1 month's salary" : `${Number(m.toFixed(2))} months' salary`;
}

/** Whether adding `amount` fits: { ok, total, room }. Exactly at the limit fits. */
export function checkLoanLimit({ loan_limit: limit, owed, amount }) {
  const total = peso(Number(owed || 0) + Number(amount || 0));
  const room = Math.max(0, peso(Number(limit || 0) - Number(owed || 0)));
  return { ok: total <= peso(limit), total, room };
}

/** "Salary limit ₱X, already owed ₱Y, you can borrow up to ₱Z." */
export function loanLimitSummary(info) {
  if (!info) return "";
  const room = Math.max(0, peso(Number(info.loan_limit) - Number(info.owed)));
  return `Salary limit ${money(info.loan_limit)}, already owed ${money(info.owed)}, you can borrow up to ${money(room)}.`;
}

/** The refusal, in the same words the database uses. */
export function loanLimitRefusal(info, amount) {
  const { total, room } = checkLoanLimit({ ...info, amount });
  return `This loan would make the total ${money(total)}, which is more than the limit of ${money(info.loan_limit)} (${multiplierText(info.multiplier)}). The most that can be added is ${money(room)}.`;
}

/** A database refusal of the limit, or null. Message cleaned of the "loan_limit:" tag. */
export function loanLimitDbRefusal(error) {
  const message = String(error?.message || "");
  if (!/loan_limit:/i.test(message)) return null;
  let detail = null;
  try { detail = error?.details ? JSON.parse(error.details) : null; } catch { detail = null; }
  return { error: message.replace(/^.*?loan_limit:\s*/i, ""), detail };
}

function toInfo(row) {
  return {
    monthly_basic: peso(row.monthly_basic),
    multiplier: Number(row.multiplier) || 1,
    loan_limit: peso(row.loan_limit),
    owed: peso(row.owed),
    room: Math.max(0, peso(row.room)),
  };
}

/**
 * The limit of each employee, from the database (loan_limit_overview).
 * Map employee id → { monthly_basic, multiplier, loan_limit, owed, room }.
 * `available: false` before the migration (nothing to show; nothing enforced).
 */
export async function loadLoanLimits(supabase, employeeIds, { exclude = null } = {}) {
  const byEmployee = new Map();
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  if (!ids.length) return { available: true, byEmployee };
  const result = await supabase.rpc("loan_limit_overview", { p_employee_ids: ids, p_exclude: exclude });
  if (result.error) return { available: false, byEmployee, error: result.error };
  (Array.isArray(result.data) ? result.data : []).forEach((row) => byEmployee.set(row.employee_id, toInfo(row)));
  return { available: true, byEmployee };
}
