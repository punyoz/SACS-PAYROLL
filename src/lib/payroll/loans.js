/**
 * Loans (public.payroll_loans / payroll_loan_payments, 20261009010000) —
 * the one loan system: salary loans, cash advances, emergency loans and
 * licensed-teacher subsidy advances.
 *
 *   Deducted on the 2nd-half payslip only (the 1st half deducts nothing),
 *   oldest loan first, after contributions, tax and any carry-over:
 *
 *     Deduction = min(amortization, remaining balance, what the payslip can still pay)
 *
 *   A short payslip deducts what fits; the shortfall stays on the balance,
 *   so the loan runs one payroll longer (never a negative payslip, never a
 *   surprise double deduction). A suspended loan and a subsidy advance are
 *   never deducted from salary.
 *
 * The balance is kept by the database (payroll_loan_payments_apply): the
 * payslip commit writes the repayments in the same transaction as the
 * payslip (payroll_commit_entries, 20261009020000), and a regenerated payslip
 * reverses its earlier repayments first. So when a period is recomputed, the
 * repayment it already made is added back to the balance here.
 */

import { roundPeso } from "@/lib/payroll/money";

const peso = (value) => roundPeso(value);

export const LOAN_TYPES = Object.freeze(["salary_loan", "cash_advance", "emergency_loan", "other", "subsidy_advance"]);
export const SALARY_LOAN_TYPES = Object.freeze(["salary_loan", "cash_advance", "emergency_loan", "other"]);
export const LOAN_TYPE_LABELS = Object.freeze({
  salary_loan: "Salary loan",
  cash_advance: "Cash advance",
  emergency_loan: "Emergency loan",
  other: "Other",
  subsidy_advance: "Subsidy advance",
});
export const LOAN_STATUSES = Object.freeze(["active", "paid", "suspended"]);

/** Flat interest on the whole loan. */
export function interestAmount(principal, interestPct) {
  return peso((Number(principal) || 0) * (Number(interestPct) || 0) / 100);
}

export function totalPayable(principal, interestPct) {
  return peso((Number(principal) || 0) + interestAmount(principal, interestPct));
}

/** Total ÷ payrolls, rounded UP to the centavo so the last payroll is never short. */
export function suggestedAmortization(total, payrolls) {
  const n = Math.max(1, Math.floor(Number(payrolls) || 0));
  return Math.ceil(((Number(total) || 0) / n) * 100) / 100;
}

/** "2026-10-16" for the 2nd half of the month a date is in, or the next one. */
export function nextSecondHalf(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (day <= 16) return `${year}-${String(month).padStart(2, "0")}-16`;
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-16`;
}

/** Validation for a new salary-deducted loan. Returns an error message, or null. */
export function validateLoanInput(input) {
  const type = String(input?.loan_type || "");
  if (!SALARY_LOAN_TYPES.includes(type)) return "Choose the loan type.";
  const principal = Number(input.principal);
  if (!(Number.isFinite(principal) && principal > 0 && principal <= 9999999.99)) return "Enter the amount lent (more than 0).";
  const pct = Number(input.interest_pct ?? 0);
  if (!(Number.isFinite(pct) && pct >= 0 && pct <= 100)) return "Interest must be between 0 and 100%.";
  const payrolls = Number(input.number_of_payrolls);
  if (!(Number.isInteger(payrolls) && payrolls >= 1 && payrolls <= 120)) return "Enter the number of payrolls (1 to 120).";
  const amortization = Number(input.amortization);
  if (!(Number.isFinite(amortization) && amortization > 0)) return "Enter the amount deducted per payroll (more than 0).";
  if (amortization > totalPayable(principal, pct)) return "The amount per payroll cannot be more than the total payable.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date_granted || ""))) return "Choose the date the loan was given.";
  if (!/^\d{4}-\d{2}-16$/.test(String(input.start_period || ""))) return "Loans are deducted on the 16–end payslip: choose a 2nd-half period to start.";
  return null;
}

/** Validation for a subsidy advance (taken against the subsidy balance, never from salary). */
export function validateSubsidyAdvanceInput(input, available) {
  const principal = Number(input?.principal);
  if (!(Number.isFinite(principal) && principal > 0)) return "Enter the advance amount (more than 0).";
  if (principal > Number(available || 0)) return `The advance is more than the subsidy balance available (${peso(available).toFixed(2)}).`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input?.date_granted || ""))) return "Choose the date the advance is released.";
  return null;
}

/** Whether a loan is deducted on this period's payslip. */
export function loanAppliesToPeriod(loan, period) {
  if (!loan || loan.status !== "active" || loan.loan_type === "subsidy_advance") return false;
  const start = String(period?.start_key || "");
  if (start.slice(8, 10) !== "16") return false;   // 2nd half only
  return String(loan.start_period || "") <= start;
}

/**
 * The repayments one 2nd-half payslip makes, oldest loan first.
 *
 * @param {object} args
 * @param {Array}  args.loans      the employee's loans, each with `balance` (see loadLoanContext)
 * @param {{ start_key: string }} args.period
 * @param {number} args.available  net pay before loans
 */
export function scheduleLoans({ loans, period, available }) {
  let room = Math.max(0, peso(available));
  const lines = [];
  [...(loans || [])]
    .filter((loan) => loanAppliesToPeriod(loan, period))
    .sort((a, b) => String(a.date_granted).localeCompare(String(b.date_granted))
      || String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .forEach((loan) => {
      const balance = Math.max(0, peso(loan.balance ?? loan.remaining_balance));
      if (balance <= 0) return;
      const due = Math.min(peso(loan.amortization), balance);
      const amount = peso(Math.min(due, room));
      room = peso(room - amount);
      lines.push({
        loan_id: String(loan.id),
        loan_type: loan.loan_type,
        description: loan.description || LOAN_TYPE_LABELS[loan.loan_type] || "Loan",
        amortization: peso(loan.amortization),
        due: peso(due),
        amount,
        shortfall: peso(due - amount),
        balance_before: balance,
        balance_after: peso(balance - amount),
      });
    });
  return { lines, total: peso(lines.reduce((sum, line) => sum + line.amount, 0)) };
}

function isMissingRelation(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("pgrst205") || text.includes("does not exist")
    || text.includes("could not find the table") || text.includes("schema cache");
}

/**
 * Active loans these employees' 2nd-half payslip for `period` may deduct,
 * each with `balance` = the stored balance plus what this period's payslip
 * already repaid (it is reversed when the payslip is regenerated).
 * Map employee id -> loans. Empty when the table does not exist yet.
 */
export async function loadLoanContext(supabase, employeeIds, period) {
  const byEmployee = new Map();
  if (!employeeIds.length || String(period?.start_key || "").slice(8, 10) !== "16") return { ready: true, byEmployee };

  const loanResult = await supabase.from("payroll_loans")
    .select("id,employee_id,loan_type,description,date_granted,principal,interest_pct,total_payable,amortization,number_of_payrolls,start_period,remaining_balance,status,created_at")
    .in("employee_id", employeeIds)
    .eq("status", "active")
    .lte("start_period", period.start_key);
  if (loanResult.error) {
    if (isMissingRelation(loanResult.error)) return { ready: true, byEmployee };
    return { ready: false, byEmployee };
  }
  const loans = (loanResult.data || []).filter((loan) => loan.loan_type !== "subsidy_advance");
  if (!loans.length) return { ready: true, byEmployee };

  const paidResult = await supabase.from("payroll_loan_payments")
    .select("loan_id,amount,kind,period_start,reversed")
    .in("loan_id", loans.map((loan) => loan.id))
    .eq("kind", "payroll")
    .eq("period_start", period.start_key)
    .eq("reversed", false);
  if (paidResult.error) return { ready: false, byEmployee };
  const thisPeriod = new Map();
  (paidResult.data || []).forEach((row) => thisPeriod.set(row.loan_id, peso((thisPeriod.get(row.loan_id) || 0) + Number(row.amount || 0))));

  loans.forEach((loan) => {
    const list = byEmployee.get(loan.employee_id) || [];
    list.push({ ...loan, balance: peso(Number(loan.remaining_balance || 0) + (thisPeriod.get(loan.id) || 0)) });
    byEmployee.set(loan.employee_id, list);
  });
  return { ready: true, byEmployee };
}
