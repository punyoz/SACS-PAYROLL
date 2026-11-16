/**
 * The shared run roster and the "Needs recompute" rule (src/lib/payroll/run-roster.js,
 * decisions 2026-11-15).
 */

import { describe, it, expect } from "vitest";
import { branchRoster, expectedInRun, firstHalfBasis, firstHalfChange, firstHalfLabelOf } from "@/lib/payroll/run-roster";

const period = { start_key: "2026-11-01", end_key: "2026-11-15", label: "November 1-15, 2026" };
const person = (id, extra = {}) => ({ id, full_name: id, branch_id: "main", archived: false, employee_status: "Active", payroll_hold: false, date_hired: "2020-01-01", ...extra });
const entry = (id, employeeId, status = "paid", extra = {}) => ({ id, employee_id: employeeId, branch_id: "main", status, run_id: null, payroll: { totals: { net_pay: 1000 } }, ...extra });

describe("the branch's active list", () => {
  it("leaves out archived, inactive, held and not-yet-hired people", () => {
    const staff = [person("a"), person("archived", { archived: true }), person("inactive", { employee_status: "Inactive" }),
      person("held", { payroll_hold: true }), person("later", { date_hired: "2026-11-16" }), person("other", { branch_id: "annex" })];
    expect(expectedInRun(staff, "main", period).map((p) => p.id)).toEqual(["a"]);
  });

  it("splits processed, Drafts, left out and payslips outside the list", () => {
    const staff = [person("a"), person("b"), person("c"), person("gone", { archived: true })];
    const roster = branchRoster({ staff, branchId: "main", period, entries: [entry("1", "a"), entry("2", "b", "draft"), entry("3", "gone")] });
    expect(roster.active).toHaveLength(3);
    expect(roster.processed.map((p) => p.id)).toEqual(["a"]);
    expect(roster.drafts.map((e) => e.employee_id)).toEqual(["b"]);
    expect(roster.missing.map((p) => p.id)).toEqual(["b", "c"]);
    expect(roster.outside.map((e) => e.employee_id)).toEqual(["gone"]);
  });
});

describe("Needs recompute", () => {
  const first = (net, extra = {}) => ({ id: "f1", status: "paid", updated_at: "2026-11-15T00:00:00Z", payslip_no: "P1",
    payroll: { totals: { net_pay: net }, monthly: { rule: "per_cutoff", window: { end_key: "2026-11-15" }, attendance_deductions: 200 } }, ...extra });
  const second = (basis) => ({ payroll: { monthly: { first_half_basis: basis } } });

  it("stores the 1st half's net, attendance deductions and id", () => {
    expect(firstHalfBasis(first(9800))).toEqual({ entry_id: "f1", version: "2026-11-15T00:00:00Z", payslip_no: "P1", net_pay: 9800, attendance_deductions: 200 });
    expect(firstHalfBasis({ ...first(9800), status: "draft" })).toBeNull();
  });

  it("is quiet when nothing changed (an approval stamp alone is no change)", () => {
    const basis = firstHalfBasis(first(9800));
    expect(firstHalfChange(second(basis), first(9800, { updated_at: "2026-11-20T00:00:00Z" }))).toBeNull();
    // Computed before 2026-11-15: nothing to compare with.
    expect(firstHalfChange(second(undefined), first(1))).toBeNull();
  });

  it("names the change, and what the 2nd half now over- or under-pays", () => {
    const basis = firstHalfBasis(first(9800));
    // Without the tax table: the 1st half's own change only (audit 2026-11-16).
    expect(firstHalfChange(second(basis), first(9300))).toEqual({
      reason: "1st half changed: net ₱9,800.00 → ₱9,300.00; 1st half alone: −₱500.00", old_net: 9800, new_net: 9300, difference: -500, month: null,
    });
    const attendance = first(9800);
    attendance.payroll.monthly.attendance_deductions = 300;
    expect(firstHalfChange(second(basis), attendance).reason).toBe("1st half changed: attendance deductions ₱200.00 → ₱300.00");
    expect(firstHalfChange(second(basis), null).reason).toBe("1st half changed: its Final payslip was removed");
    expect(firstHalfChange(second(basis), first(9800, { id: "f2" })).reason).toBe("1st half changed: its payslip was replaced");
  });

  it("knows a 2nd half's 1st half", () => {
    expect(firstHalfLabelOf("November 16-30, 2026")).toBe("November 1-15, 2026");
    expect(firstHalfLabelOf("February 16-28, 2027")).toBe("February 1-15, 2027");
    expect(firstHalfLabelOf("November 1-15, 2026")).toBeNull();
  });
});

describe("Needs recompute: what the month changes if the 2nd half is recomputed (audit 2026-11-16)", () => {
  // ₱30,000 a month. The 2nd half was computed with a ₱15,000 1st half: taxable 27,550,
  // tax (27,550 − 20,833) × 15% = 1,007.55. The 1st half was then reprocessed with
  // 2 days absent (2 × 1,379.31 = 2,758.62): net 12,241.38.
  // If recomputed: taxable 27,550 − 2,758.62 = 24,791.38 → tax (24,791.38 − 20,833) × 15% = 593.76,
  // so the 2nd half pays 1,007.55 − 593.76 = 413.79 more; the whole month −2,758.62 + 413.79 = −2,344.83.
  const TAX_ROWS = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25]]
    .map(([over, base, pct]) => ({ version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z" }));
  const firstEntry = (net, attendance) => ({ id: "f1", employee_id: "e", status: "paid", payslip_no: "PS-1", updated_at: "2026-11-16T00:00:00Z",
    payroll: { totals: { net_pay: net }, monthly: { rule: "per_cutoff", window: { start_key: "2026-11-01", end_key: "2026-11-15" }, attendance_deductions: attendance } } });
  const secondEntry = (basis) => ({ id: "s1", employee_id: "e", status: "paid", payroll: {
    audit: { period: { start_key: "2026-11-16" } },
    monthly: { first_half_basis: basis, taxable_income: 27550, withholding_tax: 1007.55, table_withholding_tax: 1007.55 } } });

  it("shows the 1st half's own change and the month's: tax ₱1,007.55 → ₱593.76, 2nd half ₱413.79 more", () => {
    const basis = firstHalfBasis(firstEntry(15000, 0));
    const change = firstHalfChange(secondEntry(basis), firstEntry(12241.38, 2758.62), { taxRows: TAX_ROWS });
    expect(change.difference).toBe(-2758.62);
    expect(change.month).toEqual({ tax_before: 1007.55, tax_after: 593.76, second_half_change: 413.79, month_net_change: -2344.83 });
    expect(change.reason).toBe("1st half changed: net ₱15,000.00 → ₱12,241.38, attendance deductions ₱0.00 → ₱2,758.62; "
      + "1st half alone: −₱2,758.62; if the 2nd half is recomputed, the month's withholding tax ₱1,007.55 → ₱593.76, so the 2nd half pays ₱413.79 more (whole month: −₱2,344.83)");
  });

  it("a logged tax override: the month's figure is not guessed", () => {
    const basis = firstHalfBasis(firstEntry(15000, 0));
    const second = secondEntry(basis);
    second.payroll.monthly.withholding_tax = 900;
    const change = firstHalfChange(second, firstEntry(12241.38, 2758.62), { taxRows: TAX_ROWS });
    expect(change.month).toBeNull();
    expect(change.reason).toMatch(/1st half alone: −₱2,758\.62$/);
  });

  it("in the exempt bracket the tax stays ₱0 and the 2nd half pays the same", () => {
    const basis = firstHalfBasis(firstEntry(9000, 0));
    const second = secondEntry(basis);
    Object.assign(second.payroll.monthly, { taxable_income: 16450, withholding_tax: 0, table_withholding_tax: 0 });
    const change = firstHalfChange(second, firstEntry(8172.41, 827.59), { taxRows: TAX_ROWS });
    expect(change.month).toMatchObject({ tax_before: 0, tax_after: 0, second_half_change: 0 });
    expect(change.reason).toMatch(/the month's withholding tax stays ₱0\.00, so the 2nd half pays the same/);
  });
});
