/**
 * The shared run roster and the "Needs recompute" rule (src/lib/payroll/run-roster.js,
 * decisions 2026-11-15).
 */

import { describe, it, expect } from "vitest";
import { branchRoster, expectedInRun, firstHalfBasis, firstHalfChange, firstHalfLabelOf } from "@/lib/payroll/run-roster";
import { periodsToCheck } from "@/lib/payroll/run-service";

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
    expect(firstHalfChange(second(basis), first(9300))).toEqual({
      reason: "1st half changed: net ₱9,800.00 → ₱9,300.00", old_net: 9800, new_net: 9300, difference: -500,
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

describe("Action needed periods", () => {
  it("every ended period from Oct 1, 2026, today's included when it ends today", () => {
    expect(periodsToCheck("2026-11-15").map((p) => p.label)).toEqual(["October 1-15, 2026", "October 16-31, 2026", "November 1-15, 2026"]);
    expect(periodsToCheck("2026-11-14").map((p) => p.label)).toEqual(["October 1-15, 2026", "October 16-31, 2026"]);
  });
});
