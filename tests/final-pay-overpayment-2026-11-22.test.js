// A final pay never shows a negative gross (2026-11-22): when the 1st half
// paid more than the month earned, the salary stays a positive earning and the
// 1st half paid is a deduction; what net pay cannot cover is "Overpayment to
// recover", listed for HR. A final pay stored before this rule (live
// PS-202610-0012: salary −₱603.45, 13th month ₱50.29) is shown the same way,
// without changing the stored record.
import { describe, expect, it } from "vitest";
import { computeFinalPay } from "@/lib/payroll/final-pay";
import { payslipTables, payslipTotalsCheck } from "@/lib/payroll/payslip-tables";
import { buildPayslipPdf } from "@/lib/payroll/payslip-pdf";
import { readPdf } from "./helpers/pdf-read";

describe("final pay with the 1st half paid above what was earned", () => {
  it("computes a positive gross, the 1st half as a deduction, net ₱0 and the overpayment to recover", () => {
    // Absent 13 days of October: ₱30,000 − 13 × ₱1,379.31 = ₱12,068.97 earned; ₱15,000 paid on the 1st half.
    const r = computeFinalPay({
      monthlySalary: 30000, dailyRate: 1379.31, separatedOn: "2026-10-21",
      months: [{ month_key: "2026-10", window: { start_key: "2026-10-01", end_key: "2026-10-21" }, absent_days: 13, partial: null, first_half_paid: 15000, first_half_basic: 15000 }],
      contributions: {}, taxTable: [], basicEarnedYtd: 0, thirteenthPaid: true, subsidy: null, benefitsYtd: 0, ceiling: 90000, carryIn: 0, loans: [],
    });
    expect(r.earnings.every((e) => e.amount >= 0)).toBe(true);
    expect(r.gross).toBeGreaterThanOrEqual(0);
    expect(r.earnings.find((e) => e.kind === "salary")).toMatchObject({ amount: 12068.97 });
    expect(r.deductions.find((d) => d.kind === "first_half_paid")).toMatchObject({ amount: 15000 });
    expect(r.net_pay).toBe(0);
    expect(r.overpayment_to_recover).toBe(Math.round((r.total_deductions - r.gross) * 100) / 100);
    expect(r.overpayment_to_recover).toBeGreaterThanOrEqual(2931.03);
  });

  it("shows a stored negative salary line as a deduction: gross never negative, the shortfall to recover, totals add up", async () => {
    // Live PS-202610-0012's stored breakdown (read-only, not changed).
    const fp = { earnings: [{ kind: "salary", month_key: "2026-10", amount: -603.45, note: "Oct 1-21; less 1st half paid ₱7,499.95" }, { kind: "thirteenth_month", amount: 50.29 }], deductions: [], gross: -553.16, total_deductions: 0 };
    const details = { status: "final", status_label: "Paid", payslip_no: "PS-202610-0012", pay_period: "Final pay — separated 2026-10-21", employee: { name: "Separated Employee" }, final_pay: fp, earnings: {}, deductions: {}, net_pay: 0 };
    const t = payslipTables(details);
    expect(t.gross).toBe(50.29);
    expect(t.earnings.map((r) => r.label)).toEqual(["13th month pay (pro-rated)"]);
    expect(t.deductions).toEqual([expect.objectContaining({ key: "first_half_paid", label: "Salary paid above earned (October 2026)", amount: 603.45 })]);
    expect(t.total_deductions).toBe(603.45);
    expect(t.overpayment_to_recover).toBe(553.16);
    expect(payslipTotalsCheck(t, details.net_pay)).toEqual([]);

    const { text } = await readPdf(await buildPayslipPdf(details));
    expect(text).toContain("Gross pay ₱50.29 − Total deductions ₱603.45 + Overpayment to recover ₱553.16 =");
    expect(text).toContain("Overpayment to recover: ₱553.16");
    expect(text).not.toMatch(/−₱553\.16|−₱603\.45|-553/);
  });
});
