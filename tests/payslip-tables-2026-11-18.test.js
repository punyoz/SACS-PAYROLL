import { describe, expect, it } from "vitest";
import { buildLineGroups } from "@/lib/payroll/line-tags";
import { payslipTables } from "@/lib/payroll/payslip-tables";
import { buildPayslipPdf } from "@/lib/payroll/payslip-pdf";
import { readPdf } from "./helpers/pdf-read";

const sum = (rows) => rows.filter((r) => !r.text).reduce((s, r) => s + (r.credit ? -r.amount : r.amount), 0);
const row = (rows, key) => rows.find((r) => r.key === key);

describe("one payslip layout for every role (2026-11-18)", () => {
  it("grouped lines: rows with an amount only (2026-11-19), loans and subsidy listed, totals add up", () => {
    const g = buildLineGroups({
      half: "second",
      additions: { basic: { label: "Basic pay (2nd half)", amount: 10000 }, perfect: { amount: 500 }, subsidy: { amount: 1000 } },
      contributions: { sss: 500, philhealth: 250, pagibig: 200 },
      tax: { amount: 0 },
      attendance: { absent: { amount: 400, days: 1 } },
      loans: [{ kind: "loan", label: "Salary loan", amount: 1000 }],
    });
    const t = payslipTables({ line_groups: { ...g, gross: 11500, total_deductions: 2350 } });
    expect(t.earnings.map((r) => r.label)).toEqual(["Basic pay (2nd half)", "Licensed teacher subsidy"]);
    expect(t.incentives.map((r) => [r.label, r.amount])).toEqual([["Perfect attendance", 500]]);
    expect(row(t.deductions, "loan-0").label).toBe("Salary loan");
    expect(t.deductions.some((r) => r.key === "loans")).toBe(false);
    expect(row(t.deductions, "late")).toBeUndefined();
    // Attendance first, then the contributions (2026-11-19).
    expect(t.deductions.map((r) => r.key).slice(0, 4)).toEqual(["absent", "sss", "philhealth", "pagibig"]);
    expect(sum(t.earnings) + sum(t.incentives)).toBe(t.gross);
    expect(sum(t.deductions)).toBe(t.total_deductions);
  });

  it("1st half: no contribution or tax rows, the note says it once", () => {
    const g = buildLineGroups({ half: "first", additions: { basic: { amount: 15000 } } });
    const t = payslipTables({ line_groups: { ...g, gross: 15000, total_deductions: 0 } });
    expect(row(t.deductions, "sss")).toBeUndefined();
    expect(row(t.deductions, "withholding_tax")).toBeUndefined();
    expect(t.notes.filter((n) => /2nd-half payslip/.test(n))).toHaveLength(1);
  });

  it("final pay: salary, 13th month, subsidy, leave conversion and loans from the stored breakdown", async () => {
    const fp = {
      earnings: [{ kind: "salary", month_key: "2026-09", amount: 9250 }, { kind: "thirteenth_month", amount: 1541.67 },
        { kind: "subsidy", amount: 2000 }, { kind: "leave_conversion", label: "Unused leave conversion", amount: 800 }],
      deductions: [{ kind: "sss", month_key: "2026-09", amount: 500 }, { kind: "loan", amount: 1000, note: "Salary loan — balance 1000.00" }],
      gross: 13591.67, total_deductions: 1500,
    };
    const t = payslipTables({ final_pay: fp, monthly: null });
    expect(t.earnings.map((r) => r.label)).toEqual(["Salary (September 2026)", "13th month pay (pro-rated)", "Licensed teacher subsidy", "Unused leave conversion"]);
    expect(t.deductions.map((r) => r.label)).toEqual(["SSS (September 2026)", "Salary loan"]);
    expect(sum(t.earnings)).toBeCloseTo(t.gross, 2);
    expect(sum(t.deductions)).toBe(t.total_deductions);
    const { text: pdf } = await readPdf(await buildPayslipPdf({ status: "final", final_pay: fp, earnings: {}, deductions: {}, net_pay: 12091.67 }));
    expect(pdf).toContain("13th month pay");
    expect(pdf).toContain("Salary loan");
  });

  it("older flat payslip keeps the classic rows", () => {
    const t = payslipTables({ earnings: { basic_salary: 18500, gross_pay: 18500 }, deductions: { cash_advance: 300, total_deductions: 300 }, incentives: {} });
    expect(t.deductions.map((r) => r.label)).toContain("Cash advance");
    expect(sum(t.deductions)).toBe(300);
  });
});
