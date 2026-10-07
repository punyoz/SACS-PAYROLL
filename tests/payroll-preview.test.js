/**
 * The Accountant portal's payroll PREVIEW (src/lib/portal/payroll-preview.js),
 * ported from public/legacy/js/accountant.js. The server recomputes every
 * entry; these pin the preview to the same rules so the screen never shows
 * a different figure from the one the server will save.
 */

import { describe, it, expect } from "vitest";
import {
  batchRowBase,
  batchRowNet,
  computeAttendanceAmounts,
  computeSummary,
  defaultForm,
  employeePayInfo,
  formDeviations,
  toAmount,
  withholdingTax,
} from "@/lib/portal/payroll-preview";

const TAX_TABLE = [
  { over: 0, base: 0, rate: 0 },
  { over: 10417, base: 0, rate: 0.15 },
  { over: 16667, base: 937.5, rate: 0.2 },
];

function payload({ half = null, legal = false } = {}) {
  return {
    tax_table: TAX_TABLE,
    semi_monthly: half ? { half } : null,
    employees: [{ id: "e1", full_name: "Maria Santos", employee_id: "SACS-014", employee_type: "Teaching", basic_salary: 25000 }],
    leave_summary: [{ employee_id: "e1", with_pay_days: 1, without_pay_days: 1 }],
    attendance_rows: [{
      employee_id: "e1",
      rates: { daily: 1000, hourly: 125, sss_pct: 2, philhealth_pct: 2, pagibig_pct: 2 },
      defaults: {
        basic_salary: half === "second" ? 25000 : 12500,
        ...(legal ? { statutory_method: "legal", sss: 1125, philhealth: 625, pagibig: 200 } : {}),
        ...(half === "second" ? { first_half_paid: 12500, other_incentive: 500 } : {}),
      },
      pay: {
        counts: { absent_days: 1, late_days: 2, undertime_minutes: 30, half_days: 0, early_bird_days: 3 },
        amounts: { absent: 1000, late: 0, undertime: 62.5, half_day: 0, early_bird: 150, perfect_attendance: 0, late_minutes_charge: 0 },
        unit_amounts: { hourly: 125, daily: 1000, half_day: 500, absent: 1000, early_bird: 50, perfect_attendance: 300, late_days_per_absent: 3, late_minute_pct: 0 },
        perfect_attendance: false,
        blocking: [],
      },
    }],
  };
}

describe("attendance amounts", () => {
  const data = payload();
  const info = employeePayInfo(data, "e1");

  it("uses the server's computed amount while a quantity is unchanged", () => {
    const a = computeAttendanceAmounts(info, { absences_days: 1, late_days: 2, undertime_minutes: 30, half_days: 0, early_bird_days: 3, perfect_attendance: false });
    expect(a).toMatchObject({ absent: 1000, late: 0, undertime: 62.5, half_day: 0, early_bird: 150, perfect_attendance: 0 });
  });

  it("prices a changed quantity at the unit rate; 3 late days = 1 absence", () => {
    const a = computeAttendanceAmounts(info, { absences_days: 2, late_days: 3, undertime_minutes: 60, half_days: 1, early_bird_days: 0, perfect_attendance: true });
    expect(a).toMatchObject({ absent: 2000, late: 1000, undertime: 125, half_day: 500, early_bird: 0, perfect_attendance: 300 });
  });
});

describe("withholding tax", () => {
  it("applies the bracket above which the taxable amount falls", () => {
    expect(withholdingTax({ tax_table: TAX_TABLE }, 10000)).toBe(0);
    expect(withholdingTax({ tax_table: TAX_TABLE }, 12417)).toBe(300);
    expect(withholdingTax({ tax_table: TAX_TABLE }, 20000)).toBe(toAmount(937.5 + 3333 * 0.2));
    expect(withholdingTax({ tax_table: [] }, 50000)).toBe(0);
  });
});

describe("computation summary", () => {
  it("flat-% period: gross less deductions plus incentives, no default tax", () => {
    const data = payload();
    const employee = data.employees[0];
    const s = computeSummary(data, employee, defaultForm(data, employee));
    // basic 12500, SSS/PhilHealth/Pag-IBIG 2% each = 250 x3, absent 1000,
    // undertime 62.5, LWOP 1 x 1000, early bird +150.
    expect(s.tax).toBe(0);
    expect(s.net).toBe(toAmount(12500 - 750 - 1000 - 62.5 - 1000 + 150));
  });

  it("2nd half: settles the month less what the 1st half paid, with the monthly tax", () => {
    const data = payload({ half: "second", legal: true });
    const employee = data.employees[0];
    const s = computeSummary(data, employee, defaultForm(data, employee));
    const taxable = 25000 + 500 + 150 - (1000 + 62.5 + 1000) - (1125 + 625 + 200);
    expect(s.taxDefault).toBe(withholdingTax(data, taxable));
    const monthNet = toAmount(25000 - (1125 + 625 + 200 + s.taxDefault + 1000 + 62.5 + 1000) + 150 + 500);
    expect(s.monthNet).toBe(monthNet);
    expect(s.net).toBe(toAmount(monthNet - 12500));
  });

  it("1st half: nothing deducted, whatever the form says", () => {
    const data = payload({ half: "first" });
    const employee = data.employees[0];
    const s = computeSummary(data, employee, { ...defaultForm(data, employee), sss: "999", absences: "5" });
    expect(s.net).toBe(12500);
  });

  it("lists the values changed from the computed defaults", () => {
    const data = payload();
    const employee = data.employees[0];
    const form = { ...defaultForm(data, employee), sss: "300", absences: "2" };
    const s = computeSummary(data, employee, form);
    expect(formDeviations(data, employee, form, s.taxDefault)).toEqual(["SSS: 250 → 300", "Absent: 1 → 2"]);
  });
});

describe("batch row", () => {
  it("matches the single-entry net for the same defaults", () => {
    const data = payload();
    const employee = data.employees[0];
    const base = batchRowBase(data, employee);
    const net = batchRowNet({
      basic_salary: base.basic, sss: base.contributions.sss, philhealth: base.contributions.philhealth, pagibig: base.contributions.pagibig,
      tax: 0, leave_without_pay_days: base.lwop, daily_rate: base.info.unit.daily, attendance_deductions: base.attendanceDeductions,
      incentives: base.incentives, earnings: base.earnings, other_incentives: base.extras.other, first_half_paid: base.extras.firstHalfPaid,
      carry_in: base.extras.carryIn, cash_advance: base.cashAdvance,
    });
    expect(net).toBe(computeSummary(data, employee, defaultForm(data, employee)).net);
  });
});
