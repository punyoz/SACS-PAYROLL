/**
 * Final pay (src/lib/payroll/final-pay.js) — worked example 7.2 of
 * docs/payroll-schedule-loans-awol.md, and the separation rules for loans and
 * the licensed-teacher subsidy.
 */

import { describe, it, expect } from "vitest";
import { computeFinalPay, paidDaysBetween } from "@/lib/payroll/final-pay";

const BIR = [{ over: 0, base: 0, rate: 0 }, { over: 20833, base: 0, rate: 0.15 }, { over: 33333, base: 1875, rate: 0.2 }, { over: 66667, base: 8541.8, rate: 0.25 }];
const set = (...days) => new Set(days);

describe("Paid days up to the separation", () => {
  it("Nov 27 – Dec 7, 2026: all absent; Bonifacio Day unpaid (absent the working day before)", () => {
    const r = paidDaysBetween({
      from: "2026-11-27", to: "2026-12-07",
      absent: set("2026-11-27", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-07"),
      unpaidLeave: set(), holidays: set("2026-11-30"),
    });
    expect(r).toEqual({ paid: 0, unpaid_holidays: ["2026-11-30"] });
  });

  it("a holiday after a day worked is paid", () => {
    expect(paidDaysBetween({ from: "2026-11-26", to: "2026-11-30", absent: set(), unpaidLeave: set(), holidays: set("2026-11-30") }).paid).toBe(3);
  });
});

describe("Worked example 7.2 — Maria, separated Dec 7, 2026", () => {
  const input = {
    monthlySalary: 30000, dailyRate: 1379.31, separatedOn: "2026-12-07",
    months: [
      { month_key: "2026-11", window: { start_key: "2026-10-30", end_key: "2026-11-26" }, absent_days: 14, first_half_paid: 0 },
      { month_key: "2026-12", window: { start_key: "2026-11-27", end_key: "2026-12-28" }, absent_days: 6, first_half_paid: 0,
        partial: { paid: 0, unpaid_holidays: ["2026-11-30"] } },
    ],
    contributions: { sss: 400, philhealth: 0, pagibig: 200 },
    taxTable: BIR,
    basicEarnedYtd: 270000 + 28491.38,
    thirteenthPaid: false,
    subsidy: null,
    benefitsYtd: 0,
    ceiling: 90000,
    carryIn: 0,
    loans: [{ id: "loan", loan_type: "salary_loan", description: "Salary loan", remaining_balance: 10500, final_pay_authorized: true, date_granted: "2026-10-05" }],
  };

  it("final pay ₱25,354.75 = 10,689.66 + 25,765.09 − 600 − 10,500", () => {
    const r = computeFinalPay(input);
    expect(r.earnings.find((e) => e.month_key === "2026-11").amount).toBe(10689.66);
    expect(r.earnings.find((e) => e.month_key === "2026-12").amount).toBe(0);
    expect(r.thirteenth_month).toBe(25765.09);
    expect(r.gross).toBe(36454.75);
    expect(r.tax).toBe(0);
    expect(r.loan_payments).toEqual([{ loan_id: "loan", kind: "final_pay", amount: 10500, amount_due: 10500 }]);
    expect(r.total_deductions).toBe(11100);
    expect(r.net_pay).toBe(25354.75);
    expect(r.uncovered).toEqual([]);
  });

  it("13th month already paid this year → not again", () => {
    expect(computeFinalPay({ ...input, thirteenthPaid: true }).thirteenth_month).toBe(0);
  });

  it("a loan final pay cannot cover stays for collection; never a negative final pay", () => {
    const r = computeFinalPay({ ...input, loans: [{ ...input.loans[0], remaining_balance: 50000 }] });
    expect(r.net_pay).toBe(0);
    expect(r.uncovered[0]).toMatchObject({ loan_id: "loan", reason: "Final pay too low" });
  });

  it("no signed authority → the loan is not deducted", () => {
    const r = computeFinalPay({ ...input, loans: [{ ...input.loans[0], final_pay_authorized: false }] });
    expect(r.net_pay).toBe(35854.75);
    expect(r.uncovered[0].reason).toMatch(/authority/);
  });
});

describe("Subsidy at separation", () => {
  const base = {
    monthlySalary: 25000, dailyRate: 1149.43, separatedOn: "2027-08-31", months: [], contributions: {}, taxTable: BIR,
    basicEarnedYtd: 0, thirteenthPaid: true, benefitsYtd: 0, ceiling: 90000, carryIn: 0,
  };
  const subsidy = { balance_id: "b", annual_amount: 24000, months_earned: 8, proration: "monthly", paid_out: 0, tax_treatment: "other_benefit" };

  it("resigns (prorate): earned 16,000 − advances 10,000 → +6,000 in final pay", () => {
    const r = computeFinalPay({ ...base, subsidy: { ...subsidy, rule: "prorate", advances_total: 10000 },
      loans: [{ id: "adv", loan_type: "subsidy_advance", remaining_balance: 10000, final_pay_authorized: true, date_granted: "2027-06-10" }] });
    expect(r.subsidy).toMatchObject({ payout: 6000, excess: 0 });
    expect(r.loan_payments).toEqual([{ loan_id: "adv", kind: "subsidy_offset", amount: 10000, amount_due: 10000 }]);
    expect(r.net_pay).toBe(6000);
  });

  it("dismissed (forfeit): unpaid part forfeited; advances above the earned part recovered", () => {
    const r = computeFinalPay({ ...base, months: [{ month_key: "2027-08", window: { start_key: "2027-07-30", end_key: "2027-08-26" }, absent_days: 0, first_half_paid: 12500 }],
      subsidy: { ...subsidy, rule: "forfeit", advances_total: 20000 },
      loans: [{ id: "adv", loan_type: "subsidy_advance", remaining_balance: 20000, final_pay_authorized: true, date_granted: "2027-02-01" }] });
    expect(r.subsidy).toMatchObject({ payout: 0, excess: 4000, forfeited: 0 });
    expect(r.loan_payments).toEqual([
      { loan_id: "adv", kind: "subsidy_offset", amount: 16000, amount_due: 16000 },
      { loan_id: "adv", kind: "final_pay", amount: 4000, amount_due: 4000 },
    ]);
  });
});
