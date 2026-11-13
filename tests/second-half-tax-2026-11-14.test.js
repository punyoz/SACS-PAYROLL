/**
 * The two halves of a month line up (report 2026-11-14, Benjie DEMO-006,
 * November 2026): each absence is deducted once, on the payslip of the half
 * it falls in; the month's tax uses the 1st half's attendance exactly as that
 * payslip deducted it; 1st-half net + 2nd-half net = monthly net.
 */

import { describe, it, expect } from "vitest";
import { computeSecondHalf } from "@/lib/payroll/semi-monthly";
import { roundPeso } from "@/lib/payroll/money";
import { computeSummary, defaultForm } from "@/lib/portal/payroll-preview";
import { previewLineGroups } from "@/lib/portal/payroll-line-preview";

const TABLE_2023 = [
  { over: 0, base: 0, rate: 0 }, { over: 20833, base: 0, rate: 0.15 }, { over: 33333, base: 1875, rate: 0.2 },
  { over: 66667, base: 8541.8, rate: 0.25 }, { over: 166667, base: 33541.8, rate: 0.3 }, { over: 666667, base: 183541.8, rate: 0.35 },
];
const DAILY = 1471.26;
const BENJIE = { monthlySalary: 32000, dailyRate: DAILY, overloadPay: 1103.46, contributions: { sss: 1600, philhealth: 800, pagibig: 200 }, taxTable: TABLE_2023 };
const days = (n) => roundPeso(n * DAILY);

/** 1st half = Rate − its own attendance; 2nd half from computeSecondHalf with that 1st half. */
function month(firstHalfAttendance, secondHalfAttendance) {
  const first = roundPeso(16000 - firstHalfAttendance);
  const second = computeSecondHalf({ ...BENJIE, absenceDeduction: secondHalfAttendance, priorAttendance: firstHalfAttendance, firstHalfPaid: first });
  return { first, second };
}

function expectLinesUp({ first, second }, secondHalfAttendance) {
  // 1st + 2nd = monthly net, to the centavo.
  expect(roundPeso(first + second.second_half_net)).toBe(second.monthly_net);
  // The 2nd half on its own: half the basic + overload − its own attendance − contributions − tax.
  expect(second.second_half_net).toBe(roundPeso(16000 + 1103.46 - secondHalfAttendance - 2600 - second.withholding_tax));
}

describe("1st and 2nd half line up", () => {
  it("Benjie: all 5 absences in Nov 1-15 (Nov 6, 10, 11, 12, 13)", () => {
    const m = month(days(5), 0);
    expect(days(5)).toBe(7356.3);
    expect(m.first).toBe(8643.7);
    expect(m.second).toMatchObject({ attendance_deductions: 7356.3, this_half_attendance_deductions: 0, taxable_income: 23147.16, withholding_tax: 347.12, monthly_net: 22800.04, second_half_net: 14156.34 });
    expectLinesUp(m, 0);
  });

  it("absences split 3 + 2: each payslip deducts its own; the month's tax sees all 5", () => {
    const m = month(days(3), days(2));
    expect(m.first).toBe(11586.22);
    expect(m.second).toMatchObject({ attendance_deductions: 7356.3, this_half_attendance_deductions: 2942.52, taxable_income: 23147.16, withholding_tax: 347.12, second_half_net: 11213.82 });
    expectLinesUp(m, days(2));
  });

  it("absences only in the 2nd half: 1st half ₱16,000; the 2nd half deducts them and the tax uses them", () => {
    const m = month(0, days(5));
    expect(m.first).toBe(16000);
    expect(m.second).toMatchObject({ attendance_deductions: 7356.3, this_half_attendance_deductions: 7356.3, taxable_income: 23147.16, withholding_tax: 347.12, second_half_net: 6800.04 });
    expectLinesUp(m, days(5));
  });

  it("1st half with a logged override (5 logged, 2 deducted): the month's tax uses the 2 days", () => {
    const m = month(days(2), 0);
    expect(m.first).toBe(13057.48);
    expect(m.second).toMatchObject({ attendance_deductions: 2942.52, taxable_income: 27560.94, withholding_tax: 1009.19, monthly_net: 26551.75, second_half_net: 13494.27 });
    expectLinesUp(m, 0);
  });
});

describe("Computation summary of a 2nd half after a per-cutoff 1st half (Benjie, 1st half a Draft)", () => {
  const data = {
    tax_table: TABLE_2023,
    semi_monthly: { half: "second" },
    employees: [{ id: "benjie", full_name: "Benjie Demo Quiambao", employee_id: "DEMO-006", employee_type: "Teaching", basic_salary: 32000 }],
    leave_summary: [],
    attendance_rows: [{
      employee_id: "benjie",
      rates: { daily: DAILY, hourly: 183.91, sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2 },
      defaults: {
        basic_salary: 32000, statutory_method: "legal", government_locked: true, sss: 1600, philhealth: 800, pagibig: 200, withholding_tax: 347.12,
        semi_monthly: "second", per_cutoff: true, prior_attendance: days(5), prior_earnings: 0,
        first_half_paid: 8643.7, first_half_status: "draft", first_half_estimate: true, first_half_basic: 16000,
        overload_hours: 6, overload_pay: 1103.46, other_incentive: 0, carry_in: 0,
      },
      // Nov 16-30: no absences of its own.
      pay: { counts: { absent_days: 0, late_days: 0, undertime_minutes: 0, half_days: 0 }, amounts: { absent: 0, late: 0, undertime: 0, half_day: 0, perfect_attendance: 0 }, unit_amounts: { daily: DAILY, hourly: 183.91, absent: DAILY, half_day: 735.63 }, perfect_attendance: false, blocking: [] },
    }],
  };
  const employee = data.employees[0];
  const form = defaultForm(data, employee);
  const summary = computeSummary(data, employee, form);
  const lines = previewLineGroups(data, employee, form, summary, form);
  const group = (key) => lines.groups.find((g) => g.key === key);

  it("shows its own half: Basic salary (2nd half) ₱16,000 + overload = ₱17,103.46; net ₱14,156.34", () => {
    expect(group("additions").lines.find((l) => l.key === "basic")).toMatchObject({ label: "Basic salary (2nd half)", amount: 16000 });
    expect(group("additions").subtotal).toBe(17103.46);
    expect(group("attendance").subtotal).toBe(0);           // the 1st half's absences are not shown again
    expect(lines.groups.some((g) => g.key === "settlement")).toBe(false);
    expect(summary.tax).toBe(347.12);
    expect(summary.net).toBe(14156.34);
  });

  it("keeps the month's tax basis visible and reconciles with the 1st half (an estimate while it is a Draft)", () => {
    expect(lines.monthly_tax).toEqual({ basic: 32000, earnings: 1103.46, attendance: 7356.3, contributions: 2600, taxable: 23147.16, tax: 347.12 });
    expect(lines.reconciliation).toEqual({ first_half_net: 8643.7, second_half_net: 14156.34, total: 22800.04, monthly_net: 22800.04, estimate: true });
  });
});
