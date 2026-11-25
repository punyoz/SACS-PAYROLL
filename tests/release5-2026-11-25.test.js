// Release 5 (2026-11-25): four payroll fixes found while taking the BEFORE/AFTER screenshots.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { payslipTables, payslipTotalsCheck } from "../src/lib/payroll/payslip-tables.js";
import { computeAttendancePay } from "../src/lib/payroll/attendance-pay.js";

const read = (p) => readFileSync(p, "utf8");
const route = read("src/app/api/accountant/payroll/route.js");

describe("rest-day overtime reaches 130 % / 169 %", () => {
  it("the payroll looks up the rest day for worked days with approved overtime, not only holidays", () => {
    expect(route).not.toMatch(/restDayHolidaysFor/);
    expect(route).toMatch(/holidays\.has\(row\.log_date\) \|\| \(Number\(overtimeMinutes\?\.get\?\.\(String\(row\.id\)\)\) \|\| 0\) > 0/);
    expect(route).toMatch(/restDaysFor\(supabase, employee, logs, holidays\.forBranch\(employee\.branch_id\), overtimeResult\.minutes\)/);
  });

  it("with the Sunday in restDays, 10 h approved overtime pays 8 h at 130 % and 2 h at 169 %", () => {
    const logs = [{ id: "sun", log_date: "2026-11-22", status: "On Time", time_in: "2026-11-22T00:00:00Z", time_out: "2026-11-22T11:00:00Z", total_hours: 10 }];
    const rates = { hourly: { value: 100 }, daily: { value: 800 }, overtime_premium_pct: { value: 25 }, rest_day_premium_pct: { value: 30 } };
    const pay = computeAttendancePay({ logs, rates, periodStart: "2026-11-16", periodEnd: "2026-11-30", overtime: new Map([["sun", 600]]),
      restDays: new Set(["2026-11-22"]), overtimeRegularPct: 125 });
    const ot = pay.earnings.filter((e) => e.type === "overtime");
    expect(ot.map((e) => e.amount)).toEqual([1040, 338]); // 8 h × 130, 2 h × 169
  });
});

describe("Approved overtime & substitutions counts the current payslip only", () => {
  it("lines of archived (recomputed) payroll records are left out", () => {
    const src = read("src/app/api/accountant/approved-overtime/route.js");
    expect(src).toMatch(/payroll_record_id/);
    expect(src).toMatch(/\.eq\("archived", true\)/);
    expect(src).toMatch(/const lines = \(allLines \|\| \[\]\)\.filter\(\(l\) => !l\.payroll_record_id \|\| !archived\.has\(l\.payroll_record_id\)\)/);
  });
});

describe("2nd-half (cutoff) payslip", () => {
  it("lists substitution and extra working day pay, one line each, in Earnings and Gross", () => {
    expect(route).toMatch(/own\("substitution", t\.substitution_pay, "Overtime \(substitution\)"\)/);
    expect(route).toMatch(/own\("special_working_day", t\.special_day_pay, "Special working day"\)/);
  });

  it("keeps the paid leave by type, through the totals and on the cutoff", () => {
    expect(route).toMatch(/leave_with_pay_by_type: leaveWithPayByType \}/);
    expect(route).toMatch(/leave_with_pay_by_type: d\.leave_with_pay_by_type && typeof d\.leave_with_pay_by_type === "object"/);
  });

  it("a cutoff with a substitution line and leave by type shows both, and the payslip adds up", () => {
    const cutoff = {
      rule: "per_cutoff", half: "second",
      earnings: [
        { label: "Basic pay (2nd cutoff)", amount: 14000, note: "Monthly salary ÷ 2" },
        { label: "Incentives", amount: 1500 },
        { label: "Overtime (substitution)", amount: 603.45, note: "Overtime (substitution): 3 h × ₱160.92 × 125%, covering Carlo Reyes Mendoza (Nov 17)" },
      ],
      deductions: [{ label: "SSS", amount: 1400 }],
      gross_pay: 16103.45, total_deductions: 1400, net_pay: 14703.45,
      leave_with_pay_days: 2, leave_with_pay_by_type: { "Vacation Leave": 1, "Sick Leave": 1 },
    };
    const t = payslipTables({ monthly: { cutoff }, gross_pay: 16103.45, total_deductions: 1400, net_pay: 14703.45 });
    const labels = t.earnings.map((r) => r.label);
    expect(labels).toContain("Overtime (substitution)");
    const leave = t.earnings.find((r) => /^Paid leave/.test(r.label));   // 2026-11-25 wording
    expect(`${leave.label} ${leave.text || leave.note || ""}`).toMatch(/2 days: Vacation 1, Sick 1/);
    expect(payslipTotalsCheck(t, 14703.45)).toEqual([]);
  });
});
