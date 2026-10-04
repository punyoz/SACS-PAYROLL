/**
 * Semi-monthly payroll formulas (src/lib/payroll/semi-monthly.js) and the
 * 13th month (src/lib/payroll/thirteenth-month.js). The payroll route runs
 * them end to end in tests/payroll-legal-rules.test.js.
 */

import { describe, it, expect } from "vitest";
import {
  computeFirstHalf,
  computeSecondHalf,
  dailyRateFor,
  lockDateKey,
  monthlyWindow,
  monthlyWithholdingTax,
  overloadPayFor,
  payrollMonthFor,
  resolveTaxTableRows,
  taxTableFromRows,
  usesSemiMonthlyRules,
} from "@/lib/payroll/semi-monthly";
import { basicEarnedFromPayroll, compute13thMonthFromEntries } from "@/lib/payroll/thirteenth-month";

const SPEC_TABLE = [
  { over: 0, base: 0, rate: 0 },
  { over: 20833, base: 0, rate: 0.2 },
  { over: 33333, base: 2500, rate: 0.25 },
  { over: 66667, base: 10833.33, rate: 0.3 },
];
const BIR_MONTHLY = [
  { over: 0, base: 0, rate: 0 },
  { over: 20833, base: 0, rate: 0.15 },
  { over: 33333, base: 1875, rate: 0.2 },
  { over: 66667, base: 8541.8, rate: 0.25 },
  { over: 166667, base: 33541.8, rate: 0.3 },
  { over: 666667, base: 183541.8, rate: 0.35 },
];

describe("semi-monthly pay", () => {
  it("starts with October 1, 2026 periods", () => {
    expect(usesSemiMonthlyRules("2026-09-16")).toBe(false);
    expect(usesSemiMonthlyRules("2026-10-01")).toBe(true);
  });

  it("1st half pays half the salary with nothing deducted", () => {
    expect(computeFirstHalf({ monthlySalary: 32000 })).toEqual({ semi_monthly_pay: 16000, gross_pay: 16000, total_deductions: 0, net_pay: 16000 });
  });

  it("2nd half matches the test case", () => {
    const result = computeSecondHalf({
      monthlySalary: 32000,
      divisor: 261,
      absentDays: 2,
      leaveWithPayDays: 1,
      incentives: 500,
      contributions: { sss: 900, philhealth: 200, pagibig: 100 },
      taxTable: SPEC_TABLE,
      firstHalfPaid: 16000,
    });
    expect(result).toMatchObject({
      daily_rate: 1471.26,
      hourly_rate: 183.91,
      absence_deduction: 2942.52,
      monthly_gross: 29557.48,
      taxable_income: 28357.48,
      withholding_tax: 1504.9,
      monthly_net: 26852.58,
      first_half_paid: 16000,
      second_half_net: 10852.58,
      net_pay: 10852.58,
      carry_over_out: 0,
    });
  });

  it("charges Leave Without Pay at the daily rate and Leave With Pay nothing", () => {
    const withLwop = computeSecondHalf({ monthlySalary: 32000, divisor: 261, absentDays: 2, leaveWithoutPayDays: 1, taxTable: BIR_MONTHLY });
    expect(withLwop.absence_deduction).toBe(4413.78);
    const paidLeave = computeSecondHalf({ monthlySalary: 32000, divisor: 261, leaveWithPayDays: 3, taxTable: BIR_MONTHLY });
    expect(paidLeave.absence_deduction).toBe(0);
  });

  it("pays overload at the hourly rate plus the premium", () => {
    expect(overloadPayFor(183.91, 10)).toBe(1839.1);
    expect(overloadPayFor(183.91, 10, 25)).toBe(2298.88);
    const result = computeSecondHalf({ monthlySalary: 32000, divisor: 261, overloadHours: 10, taxTable: BIR_MONTHLY });
    expect(result.overload_pay).toBe(1839.1);
    expect(result.monthly_gross).toBe(33839.1);
  });

  it("carries a negative 2nd half to next month", () => {
    const result = computeSecondHalf({ monthlySalary: 20000, divisor: 261, absentDays: 12, taxTable: BIR_MONTHLY, firstHalfPaid: 10000, carryIn: 0 });
    expect(result.second_half_net).toBeLessThan(0);
    expect(result.net_pay).toBe(0);
    expect(result.carry_over_out).toBe(-result.second_half_net);
  });

  it("divides by working days per month when the divisor is 31 or less", () => {
    expect(dailyRateFor(32000, 261)).toBe(1471.26);
    expect(dailyRateFor(32000, 313)).toBe(1226.84);
    expect(dailyRateFor(32000, 22)).toBe(1454.55);
  });
});

describe("monthly withholding tax", () => {
  it("applies the BIR monthly table", () => {
    expect(monthlyWithholdingTax(20833, BIR_MONTHLY)).toBe(0);
    expect(monthlyWithholdingTax(28357.48, BIR_MONTHLY)).toBe(1128.67);
    expect(monthlyWithholdingTax(52095, BIR_MONTHLY)).toBe(5627.4);
    expect(monthlyWithholdingTax(100000, BIR_MONTHLY)).toBe(16875.05);
  });

  it("reads the newest version in force from the database rows", () => {
    const rows = [
      { version_id: "a", effective_date: "2023-01-01", created_at: "1", bracket_over: 0, base_tax: 0, rate_pct: 0 },
      { version_id: "a", effective_date: "2023-01-01", created_at: "1", bracket_over: 20833, base_tax: 0, rate_pct: 15 },
      { version_id: "b", effective_date: "2026-11-01", created_at: "2", bracket_over: 0, base_tax: 0, rate_pct: 0 },
      { version_id: "b", effective_date: "2026-11-01", created_at: "2", bracket_over: 20833, base_tax: 0, rate_pct: 20 },
    ];
    expect(taxTableFromRows(resolveTaxTableRows(rows, "2026-10-16"))[1]).toEqual({ over: 20833, base: 0, rate: 0.15 });
    expect(taxTableFromRows(resolveTaxTableRows(rows, "2026-11-16"))[1]).toEqual({ over: 20833, base: 0, rate: 0.2 });
  });
});

describe("attendance lock", () => {
  const lock28 = () => 28;

  it("covers last month's lock + 1 to this month's lock", () => {
    expect(lockDateKey("2026-10", 28)).toBe("2026-10-28");
    expect(lockDateKey("2026-10", 0)).toBe("2026-10-31");
    expect(monthlyWindow("2026-10", lock28)).toEqual({ start_key: "2026-10-01", end_key: "2026-10-28" });
    expect(monthlyWindow("2026-11", lock28)).toEqual({ start_key: "2026-10-29", end_key: "2026-11-28" });
    expect(monthlyWindow("2027-03", lock28)).toEqual({ start_key: "2027-03-01", end_key: "2027-03-28" });
  });

  it("moves anything filed after the lock to next month", () => {
    expect(payrollMonthFor("2026-10-20", "2026-10-20", lock28)).toBe("2026-10");
    expect(payrollMonthFor("2026-10-20", "2026-10-29", lock28)).toBe("2026-11");
    expect(payrollMonthFor("2026-10-30", "2026-10-30", lock28)).toBe("2026-11");
    expect(payrollMonthFor("2026-12-29", "2026-12-29", lock28)).toBe("2027-01");
  });
});

describe("13th month", () => {
  it("is the basic earned in the year less unpaid absences, over 12", () => {
    const entries = [
      // Before semi-monthly payroll: basic less Absent and Leave Without Pay.
      { pay_period: "September 16-30, 2026", status: "paid", payroll: { basic_salary: 16000, totals: { absence_deduction: 1000, leave_without_pay_deduction: 500, late_deduction: 300 } } },
      { pay_period: "October 1-15, 2026", status: "paid", payroll: { basic_salary: 16000, basic_earned: 16000 } },
      { pay_period: "October 16-31, 2026", status: "paid", payroll: { basic_salary: 32000, basic_earned: 13057.48 } },
      { pay_period: "November 1-15, 2026", status: "draft", payroll: { basic_salary: 16000, basic_earned: 16000 } },
      { pay_period: "December 16-31, 2025", status: "paid", payroll: { basic_salary: 16000, basic_earned: 16000 } },
    ];
    const result = compute13thMonthFromEntries(entries, 2026);
    expect(result.periods.map((p) => p.pay_period)).toEqual(["September 16-30, 2026", "October 1-15, 2026", "October 16-31, 2026"]);
    expect(result.total_basic_earned).toBe(43557.48);
    expect(result.amount).toBe(3629.79);
    expect(basicEarnedFromPayroll(null)).toBe(0);
  });
});
