/**
 * Final pay after a 1st half already paid (decided 2026-11-15, FUTURE final
 * pays only; stored final pays such as Anjo Saraga's PS-202610-0012 are not
 * changed).
 *
 * Anjo (separated 2026-10-21) was absent every day from Oct 1 to Oct 21, yet
 * the October 1-15 payslip had paid 603.45 (its window ended Oct 14 and paid
 * the 15th in advance; the 2nd half would have deducted it). The stored final
 * pay showed gross -553.16 and net 0:
 *   salary       0 paid days × 689.65 − 1st half paid 603.45   = -603.45
 *   13th month   (603.45 + 0.00) ÷ 12                          =  +50.29  ← the 1st half counted again
 *
 * Fixes:
 *   a. the 13th month counts the 1st half once: the final pay adds only the
 *      basic it earns on top of what the 1st half already paid;
 *   b. a shortfall stays floored at 0 in net pay but is reported as
 *      overpayment_to_recover (never deducted automatically).
 */

import { describe, it, expect } from "vitest";
import { computeFinalPay } from "@/lib/payroll/final-pay";

const anjo = {
  monthlySalary: 15000,
  dailyRate: 689.65,
  separatedOn: "2026-10-21",
  months: [{
    month_key: "2026-10", window: { start_key: "2026-10-01", end_key: "2026-10-29" }, absent_days: 15,
    first_half_paid: 603.45, first_half_basic: 603.45, partial: { paid: 0, unpaid_holidays: [] },
  }],
  basicEarnedYtd: 603.45, // the October 1-15 payslip's basic
  thirteenthPaid: false,
  contributions: {},
  taxTable: [],
  loans: [],
};

describe("Final pay after an overpaid 1st half (Anjo's case, hand-checked)", () => {
  it("a. no 13th month on a 1st half taken back; b. the 603.45 is reported to recover", () => {
    const r = computeFinalPay(anjo);
    // salary earned: 0 × 689.65 = 0; the 603.45 1st half is a deduction (2026-11-22: never a negative gross)
    expect(r.earnings.find((e) => e.kind === "salary").amount).toBe(0);
    expect(r.deductions.find((d) => d.kind === "first_half_paid").amount).toBe(603.45);
    // 13th month: (603.45 YTD + (0 − 603.45) added) ÷ 12 = 0 → no line
    expect(r.thirteenth_month).toBe(0);
    expect(r.earnings.some((e) => e.kind === "thirteenth_month")).toBe(false);
    // gross 0 (never negative), net floored at 0, the shortfall reported
    expect(r.gross).toBe(0);
    expect(r.net_pay).toBe(0);
    expect(r.overpayment_to_recover).toBe(603.45);
  });

  it("nothing is deducted automatically: a loan with authority is not touched by the shortfall", () => {
    const r = computeFinalPay({ ...anjo, loans: [{ id: "loan", loan_type: "salary", remaining_balance: 1000, final_pay_authorized: true, date_granted: "2026-09-01" }] });
    expect(r.loan_payments).toEqual([]);
    expect(r.uncovered).toEqual([{ loan_id: "loan", amount: 1000, reason: "Final pay too low" }]);
    expect(r.overpayment_to_recover).toBe(603.45);
  });
});

describe("Final pay 13th month counts the 1st half once (ordinary separation, hand-checked)", () => {
  // Separated Oct 21 after 10 paid days in October: earned 10 × 689.65 = 6,896.50.
  // The October 1-15 payslip paid 5,000.00 basic, already in the year to date.
  const ordinary = { ...anjo, months: [{ ...anjo.months[0], first_half_paid: 5000, first_half_basic: 5000, partial: { paid: 10, unpaid_holidays: [] } }], basicEarnedYtd: 5000 };

  it("adds only the 1,896.50 earned on top of the 1st half", () => {
    const r = computeFinalPay(ordinary);
    // salary: 6,896.50 − 5,000.00 = 1,896.50
    expect(r.earnings.find((e) => e.kind === "salary").amount).toBe(1896.5);
    expect(r.basic_earned).toBe(1896.5);
    // 13th month: (5,000.00 + 1,896.50) ÷ 12 = 574.708… → 574.71 (it was 991.38: the 5,000 twice)
    expect(r.thirteenth_month).toBe(574.71);
    expect(r.gross).toBe(2471.21);
    expect(r.net_pay).toBe(2471.21);
    expect(r.overpayment_to_recover).toBe(0);
  });

  it("without a 1st half paid, nothing changes: the month's whole basic counts", () => {
    const r = computeFinalPay({ ...ordinary, months: [{ ...ordinary.months[0], first_half_paid: 0, first_half_basic: 0 }], basicEarnedYtd: 0 });
    expect(r.basic_earned).toBe(6896.5);
    expect(r.thirteenth_month).toBe(574.71); // 6,896.50 ÷ 12
  });
});
