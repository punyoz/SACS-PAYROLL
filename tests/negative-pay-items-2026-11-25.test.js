// A negative pay item on a 2nd-half payslip is listed, so the payslip adds up (2026-11-25).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitNegativeIncentives } from "@/lib/payroll/negative-items";

const payroll = (lines) => ({ audit: { lines: { incentives: lines } } });

describe("negative pay items", () => {
  it("a take-back becomes its own deduction line; Incentives keeps the positive part; the lines add up", () => {
    const p = payroll([
      { type: "incentive", amount: 1000, note: "Honorarium" },
      { type: "incentive", amount: -500, note: "Adjustment: Overpaid incentive (November 1-15, 2026). Paid twice by mistake" },
    ]);
    const r = splitNegativeIncentives(p, 500);   // totals.other_incentive = 1,000 − 500
    expect(r.incentives).toBe(1000);
    expect(r.deductions).toEqual([{ label: "Overpaid incentive (November 1-15, 2026)", amount: 500, note: "Paid twice by mistake" }]);
    // Gross counts +1,000, deductions +500: net change 500 = totals.other_incentive.
    expect(r.incentives - r.deductions.reduce((s, d) => s + d.amount, 0)).toBe(500);
  });

  it("only positive items: nothing changes", () => {
    expect(splitNegativeIncentives(payroll([{ type: "incentive", amount: 800 }]), 800)).toEqual({ incentives: 800, deductions: [] });
  });

  it("no lines (an older payslip): the total as before", () => {
    expect(splitNegativeIncentives({}, 300)).toEqual({ incentives: 300, deductions: [] });
  });

  it("the 2nd-half line list uses it (route)", () => {
    const route = readFileSync("src/app/api/accountant/payroll/route.js", "utf8");
    expect(route).toMatch(/const negativeItems = splitNegativeIncentives\(payroll, t\.other_incentive\);/);
    expect(route).toMatch(/negativeItems\.deductions\.forEach\(\(l\) => deduct\(l\.label, l\.amount, l\.note\)\);/);
  });
});
