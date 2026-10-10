/**
 * Final pay for a separated employee (docs/payroll-schedule-loans-awol.md
 * §5.4, worked example 7.2). Released within 30 days of separation (DOLE
 * Labor Advisory 06-2020).
 *
 *   + unpaid salary up to the separation date
 *       a month whose whole attendance window is on or before the separation:
 *         Monthly Salary − absences (capped at the salary), less any 1st half paid
 *       the month the separation falls in: paid days × daily rate
 *         (working days up to the separation, less absences / leave without
 *          pay; a holiday is paid only if the working day before was not an
 *          absence — the Labor Code holiday-pay rule)
 *   + pro-rated 13th month   (basic earned this year ÷ 12; owed whatever the
 *                             reason for separation; skipped when already paid)
 *   + licensed-teacher subsidy earned and not yet paid (prorate rule)
 *   − contributions (months with earnings) − withholding tax (monthly table;
 *     13th month + subsidy above the exempt ceiling are taxable)
 *   − carry-over owed from the last 2nd half
 *   − loans (only with the signed final-pay authority), oldest first, and
 *     subsidy advances above what was earned
 *   = final pay, never below zero; what it cannot cover stays on the loan
 *     ("Separated – for collection").
 */

import { roundPeso } from "@/lib/payroll/money";
import { monthlyWithholdingTax } from "@/lib/payroll/semi-monthly";

const peso = (value) => roundPeso(value);

function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isWeekend = (key) => [0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay());

/**
 * Paid days in [from, to]: working days not absent / unpaid leave; a
 * whole-day holiday on a weekday is paid unless the working day before it
 * was an absence.
 * @param {{ from: string, to: string, absent: Set<string>, unpaidLeave: Set<string>, holidays: Set<string> }} args
 */
export function paidDaysBetween({ from, to, absent, unpaidLeave, holidays }) {
  let paid = 0;
  const unpaidHolidays = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (isWeekend(day)) continue;
    if (holidays.has(day)) {
      let prev = addDays(day, -1);
      while (isWeekend(prev) || holidays.has(prev)) prev = addDays(prev, -1);
      if (absent.has(prev) || unpaidLeave.has(prev)) unpaidHolidays.push(day);
      else paid += 1;
      continue;
    }
    if (absent.has(day) || unpaidLeave.has(day)) continue;
    paid += 1;
  }
  return { paid, unpaid_holidays: unpaidHolidays };
}

/**
 * @param {object} input
 * @param {number} input.monthlySalary
 * @param {number} input.dailyRate
 * @param {string} input.separatedOn                 last day of employment
 * @param {Array<{ month_key, window: { start_key, end_key }, absent_days: number,
 *   first_half_paid: number, partial?: { paid: number, unpaid_holidays: string[] } }>} input.months
 *   unsettled months, oldest first; `partial` for the month the separation falls in
 * @param {{ sss: number, philhealth: number, pagibig: number }} input.contributions  monthly
 * @param {Array} input.taxTable                     monthly table rows ({ over, base, rate })
 * @param {number} input.basicEarnedYtd              from this year's Final payslips
 * @param {boolean} input.thirteenthPaid             13th month already processed this year
 * @param {object|null} input.subsidy                { rule: prorate | forfeit, annual_amount, months_earned,
 *                                                     proration, advances_total, paid_out, tax_treatment, balance_id }
 * @param {number} input.benefitsYtd                 exempt benefits already paid this year
 * @param {number} input.ceiling                     benefits_exempt_ceiling
 * @param {number} input.carryIn                     carry-over owed
 * @param {Array} input.loans                        { id, loan_type, description, remaining_balance,
 *                                                     final_pay_authorized, date_granted }
 */
export function computeFinalPay(input) {
  const salary = peso(input.monthlySalary);
  const daily = peso(input.dailyRate);
  const earnings = [];
  const deductions = [];
  let taxableTotal = 0;
  let taxTotal = 0;
  let basicEarned = 0;

  (input.months || []).forEach((month) => {
    let earned;
    let note;
    if (month.partial) {
      earned = Math.min(salary, peso(month.partial.paid * daily));
      note = `${month.partial.paid} paid day${month.partial.paid === 1 ? "" : "s"} × ${daily.toFixed(2)} (${month.window.start_key} – ${input.separatedOn})`
        + (month.partial.unpaid_holidays.length ? `; holiday${month.partial.unpaid_holidays.length > 1 ? "s" : ""} ${month.partial.unpaid_holidays.join(", ")} unpaid (absent the working day before)` : "");
    } else {
      const absence = Math.min(salary, peso(month.absent_days * daily));
      earned = peso(salary - absence);
      note = `${salary.toFixed(2)} − ${month.absent_days} absence${month.absent_days === 1 ? "" : "s"} × ${daily.toFixed(2)} (${month.window.start_key} – ${month.window.end_key})`;
    }
    basicEarned = peso(basicEarned + earned);
    const firstHalf = peso(month.first_half_paid || 0);
    earnings.push({ kind: "salary", month_key: month.month_key, amount: peso(earned - firstHalf), gross: earned, note: firstHalf ? `${note}; less 1st half paid ${firstHalf.toFixed(2)}` : note });

    if (earned > 0) {
      const c = input.contributions || {};
      const contrib = peso(Number(c.sss || 0) + Number(c.philhealth || 0) + Number(c.pagibig || 0));
      ["sss", "philhealth", "pagibig"].forEach((type) => {
        if (Number(c[type]) > 0) deductions.push({ kind: type, month_key: month.month_key, amount: peso(c[type]) });
      });
      const taxable = Math.max(0, peso(earned - contrib));
      taxableTotal = peso(taxableTotal + taxable);
      const tax = monthlyWithholdingTax(taxable, input.taxTable || []);
      if (tax > 0) deductions.push({ kind: "withholding_tax", month_key: month.month_key, amount: tax });
      taxTotal = peso(taxTotal + tax);
    }
  });

  // Pro-rated 13th month.
  let thirteenth = 0;
  if (!input.thirteenthPaid) {
    thirteenth = peso((Number(input.basicEarnedYtd || 0) + basicEarned) / 12);
    if (thirteenth > 0) earnings.push({ kind: "thirteenth_month", amount: thirteenth, note: `(${peso(input.basicEarnedYtd || 0).toFixed(2)} + ${basicEarned.toFixed(2)}) ÷ 12` });
  }

  // Licensed-teacher subsidy, by the separation rule.
  let subsidyPayout = 0;
  let subsidyExcess = 0;
  let subsidyForfeited = 0;
  const s = input.subsidy;
  if (s) {
    const earnedSubsidy = s.months_earned > 0 ? (s.proration === "none" ? peso(s.annual_amount) : peso(s.annual_amount * s.months_earned / 12)) : 0;
    const taken = peso(Number(s.advances_total || 0) + Number(s.paid_out || 0));
    if (s.rule === "prorate") {
      subsidyPayout = Math.max(0, peso(earnedSubsidy - taken));
    } else {
      subsidyForfeited = Math.max(0, peso(earnedSubsidy - taken));
    }
    subsidyExcess = Math.max(0, peso(taken - earnedSubsidy));
    if (subsidyPayout > 0) earnings.push({ kind: "subsidy", amount: subsidyPayout, note: `Earned ${earnedSubsidy.toFixed(2)} (${s.months_earned} month${s.months_earned === 1 ? "" : "s"}) − advances ${taken.toFixed(2)}` });
  }

  // 13th month + other-benefit subsidy above the exempt ceiling are taxable.
  const benefits = peso(thirteenth + (s?.tax_treatment === "other_benefit" ? subsidyPayout : 0));
  const excess = Math.max(0, peso(Number(input.benefitsYtd || 0) + benefits - Number(input.ceiling || 90000)));
  const subsidyTaxable = s?.tax_treatment === "taxable" ? subsidyPayout : 0;
  if (excess + subsidyTaxable > 0) {
    const before = monthlyWithholdingTax(0, input.taxTable || []);
    const extra = peso(monthlyWithholdingTax(excess + subsidyTaxable, input.taxTable || []) - before);
    if (extra > 0) { deductions.push({ kind: "withholding_tax", note: "On 13th month / subsidy above the exempt ceiling", amount: extra }); taxTotal = peso(taxTotal + extra); }
  }

  if (Number(input.carryIn) > 0) deductions.push({ kind: "carry_over", amount: peso(input.carryIn), note: "Balance carried over from the last 2nd half" });

  const gross = peso(earnings.reduce((sum, e) => sum + e.amount, 0));
  let room = peso(gross - deductions.reduce((sum, d) => sum + d.amount, 0));

  // Loans, oldest first; subsidy advances only for the part above what was earned.
  const loanPayments = [];
  const uncovered = [];
  let excessLeft = subsidyExcess;
  [...(input.loans || [])]
    .filter((loan) => Number(loan.remaining_balance) > 0)
    .sort((a, b) => String(a.date_granted).localeCompare(String(b.date_granted)))
    .forEach((loan) => {
      const isAdvance = loan.loan_type === "subsidy_advance";
      const due = isAdvance ? Math.min(peso(loan.remaining_balance), excessLeft) : peso(loan.remaining_balance);
      const offset = isAdvance ? peso(loan.remaining_balance - due) : 0;   // covered by the subsidy earned
      if (isAdvance) excessLeft = peso(excessLeft - due);
      if (offset > 0) loanPayments.push({ loan_id: loan.id, kind: "subsidy_offset", amount: offset, amount_due: offset });
      if (due <= 0) return;
      if (!loan.final_pay_authorized) { uncovered.push({ loan_id: loan.id, amount: due, reason: "No signed final-pay authority" }); return; }
      const amount = Math.min(due, Math.max(0, room));
      room = peso(room - amount);
      if (amount > 0) {
        loanPayments.push({ loan_id: loan.id, kind: "final_pay", amount, amount_due: due });
        deductions.push({ kind: "loan", loan_id: loan.id, amount, note: `${loan.description || (isAdvance ? "Subsidy advance above what was earned" : "Loan")} — balance ${peso(loan.remaining_balance).toFixed(2)}` });
      }
      if (amount < due) uncovered.push({ loan_id: loan.id, amount: peso(due - amount), reason: "Final pay too low" });
    });

  const totalDeductions = peso(deductions.reduce((sum, d) => sum + d.amount, 0));
  const net = Math.max(0, peso(gross - totalDeductions));
  return {
    earnings,
    deductions,
    gross,
    total_deductions: totalDeductions,
    net_pay: net,
    basic_earned: basicEarned,
    thirteenth_month: thirteenth,
    taxable: taxableTotal,
    tax: taxTotal,
    subsidy: s ? { payout: subsidyPayout, forfeited: subsidyForfeited, excess: subsidyExcess, balance_id: s.balance_id } : null,
    loan_payments: loanPayments,
    uncovered,
  };
}
