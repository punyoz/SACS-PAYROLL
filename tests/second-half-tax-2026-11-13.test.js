/**
 * 2nd-half withholding tax on the whole month (report 2026-11-13, Benjie
 * DEMO-006). The 2nd half taxes the month's gross less the whole month's
 * attendance and contributions, then pays the monthly net less what the
 * 1st half released.
 */

import { describe, it, expect } from "vitest";
import { computeSecondHalf, monthlyWithholdingTax } from "@/lib/payroll/semi-monthly";

// BIR monthly table (RR 11-2018, 2023 onward).
const TABLE_2023 = [
  { over: 0, base: 0, rate: 0 },
  { over: 20833, base: 0, rate: 0.15 },
  { over: 33333, base: 1875, rate: 0.2 },
  { over: 66667, base: 8541.8, rate: 0.25 },
  { over: 166667, base: 33541.8, rate: 0.3 },
  { over: 666667, base: 183541.8, rate: 0.35 },
];
const BENJIE = {
  monthlySalary: 32000,
  dailyRate: 1471.26,
  overloadPay: 1103.46, // 6 h × ₱183.91
  contributions: { sss: 1600, philhealth: 800, pagibig: 200 },
  taxTable: TABLE_2023,
};

describe("2nd half: tax on the whole month", () => {
  it("Benjie, no absences, 1st half released ₱16,000", () => {
    const r = computeSecondHalf({ ...BENJIE, firstHalfPaid: 16000 });
    expect(r.monthly_gross).toBe(33103.46);
    expect(r.contributions).toBe(2600);
    expect(r.taxable_income).toBe(30503.46);
    expect(r.tax_bracket).toEqual({ over: 20833, base: 0, rate_pct: 15 });
    expect(r.withholding_tax).toBe(1450.57);
    expect(r.monthly_net).toBe(29052.89);
    expect(r.second_half_net).toBe(13052.89);
  });

  it("Benjie, 2 days absent in the 1st half (₱2,942.52), 1st half released ₱13,057.48", () => {
    const r = computeSecondHalf({ ...BENJIE, priorAttendance: 2942.52, firstHalfPaid: 13057.48 });
    expect(r.attendance_deductions).toBe(2942.52);
    expect(r.taxable_income).toBe(27560.94);
    expect(r.withholding_tax).toBe(1009.19);
    expect(r.second_half_net).toBe(13494.27);
  });

  it("monthly taxable income below ₱20,833: no tax", () => {
    const r = computeSecondHalf({ monthlySalary: 20000, contributions: { sss: 1000, philhealth: 500, pagibig: 200 }, taxTable: TABLE_2023, firstHalfPaid: 10000 });
    expect(r.taxable_income).toBe(18300);
    expect(r.withholding_tax).toBe(0);
  });

  it("bracket edges: exactly ₱20,833 is exempt, exactly ₱33,333 stays in the 15% bracket", () => {
    expect(monthlyWithholdingTax(20833, TABLE_2023)).toBe(0);
    expect(monthlyWithholdingTax(33333, TABLE_2023)).toBe(1875);
    expect(monthlyWithholdingTax(33333.01, TABLE_2023)).toBe(1875);
  });
});
