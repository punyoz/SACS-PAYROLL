/**
 * Final pay: the tax on the 13th month above the ₱90,000 exempt ceiling
 * (audit 2026-11-16). It is taxed ON TOP of the separation month's pay:
 * tax(month taxable + excess) − tax(month taxable), never from zero.
 *
 * Every expected figure is worked out by hand from the system's monthly BIR
 * table (payroll_tax_brackets, 2023):
 *   over 20,833 → 15%;  over 33,333 → 1,875 + 20%;  over 66,667 → 8,541.80 + 25%
 *
 * The month: ₱60,000 salary, the whole of November worked, 1st half ₱30,000
 * paid. Contributions (passed in) 1,750 + 1,500 + 200 = 3,450.
 *   month taxable T = 60,000 − 3,450 = 56,550
 *   tax(T) = 1,875 + (56,550 − 33,333) × 20% = 1,875 + 4,643.40 = 6,518.40
 * The 13th month = (basic earned this year + this final pay's 30,000) ÷ 12,
 * set through basicEarnedYtd.
 */
import { describe, it, expect } from "vitest";
import { computeFinalPay } from "@/lib/payroll/final-pay";

const BIR = [{ over: 0, base: 0, rate: 0 }, { over: 20833, base: 0, rate: 0.15 }, { over: 33333, base: 1875, rate: 0.2 }, { over: 66667, base: 8541.8, rate: 0.25 }, { over: 166667, base: 33541.8, rate: 0.3 }];

const run = (basicEarnedYtd, extra = {}) => computeFinalPay({
  monthlySalary: 60000, dailyRate: 2758.62, separatedOn: "2026-11-30",
  months: [{ month_key: "2026-11", window: { start_key: "2026-11-01", end_key: "2026-11-30" }, absent_days: 0, first_half_paid: 30000, first_half_basic: 30000 }],
  contributions: { sss: 1750, philhealth: 1500, pagibig: 200 },
  taxTable: BIR, basicEarnedYtd, thirteenthPaid: false, subsidy: null, benefitsYtd: 0, ceiling: 90000, carryIn: 0, loans: [],
  ...extra,
});
const excessTax = (r) => r.deductions.filter((d) => d.kind === "withholding_tax" && d.note).reduce((s, d) => s + d.amount, 0);
const monthTax = (r) => r.deductions.filter((d) => d.kind === "withholding_tax" && !d.note).reduce((s, d) => s + d.amount, 0);

describe("Final pay: tax on the 13th month above the ₱90,000 ceiling", () => {
  it("under the ceiling (13th month ₱60,000): no extra tax, exactly as before", () => {
    // (690,000 + 30,000) ÷ 12 = 60,000 ≤ 90,000 → excess 0.
    const r = run(690000);
    expect(r.earnings.find((e) => e.kind === "thirteenth_month").amount).toBe(60000);
    expect(monthTax(r)).toBe(6518.4);
    expect(excessTax(r)).toBe(0);
    expect(r.tax).toBe(6518.4);
  });

  it("exactly at the ceiling (13th month ₱90,000): no extra tax", () => {
    // (1,050,000 + 30,000) ÷ 12 = 90,000 → excess 0.
    const r = run(1050000);
    expect(r.earnings.find((e) => e.kind === "thirteenth_month").amount).toBe(90000);
    expect(excessTax(r)).toBe(0);
    expect(r.tax).toBe(6518.4);
  });

  it("above the ceiling (13th month ₱96,000, excess ₱6,000): ₱1,200.00 on top of the month (was ₱0 from zero)", () => {
    // (1,122,000 + 30,000) ÷ 12 = 96,000 → excess 6,000.
    // tax(56,550 + 6,000) = 1,875 + (62,550 − 33,333) × 20% = 7,718.40; − 6,518.40 = 1,200.00.
    // Before the fix: tax(6,000) − tax(0) = 0 (6,000 ≤ 20,833).
    const r = run(1122000);
    expect(r.earnings.find((e) => e.kind === "thirteenth_month").amount).toBe(96000);
    expect(excessTax(r)).toBe(1200);
    expect(r.tax).toBe(7718.4);
  });

  it("above the ceiling across a bracket (excess ₱20,000): ₱4,494.15", () => {
    // (1,290,000 + 30,000) ÷ 12 = 110,000 → excess 20,000.
    // tax(76,550) = 8,541.80 + (76,550 − 66,667) × 25% = 8,541.80 + 2,470.75 = 11,012.55; − 6,518.40 = 4,494.15.
    const r = run(1290000);
    expect(excessTax(r)).toBe(4494.15);
    expect(r.tax).toBe(11012.55);
  });

  it("no pay in the month (taxable 0): the excess is taxed from zero, as before", () => {
    // A month with nothing earned: T = 0, so tax(0 + 6,000) − tax(0) = 0, the same as the old rule.
    const r = run(1152000, { months: [{ month_key: "2026-11", window: { start_key: "2026-11-01", end_key: "2026-11-30" }, absent_days: 30, first_half_paid: 0, first_half_basic: 0 }] });
    expect(monthTax(r)).toBe(0);
    expect(excessTax(r)).toBe(0);
  });
});
