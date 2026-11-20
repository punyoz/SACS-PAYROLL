/**
 * Part A (panel revisions 2026-11-20, 20261121010000): category, employment
 * status and type; dated history; leave credits per classification; pay rules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHANGE_WITH_DATE, changedClassification, classificationLabel, classificationOn, classificationSegments,
  eligibilityError, leaveEntitlement, legalMinimumWarnings, payRuleFor,
} from "@/lib/employees/classification";
import { EMPLOYMENT_STATUS_OPTIONS } from "@/lib/employees/record";

const NOW = { employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time", on_payroll: true };
// Probationary from hire, Regular from Mar 1, 2027 (the plan's example).
const HISTORY = [
  { field: "employment_status", old_value: "Probationary", new_value: "Regular", effective_on: "2027-03-01", created_at: "2026-11-20T00:00:00Z" },
];

/** One rule row per leave type for a combination. */
function rules(c, days, from = "2026-01-01") {
  return Object.entries(days).map(([leave_type, days_per_year]) => ({ leave_type, ...c, days_per_year, effective_from: from }));
}
const REG = { employee_type: "Teaching", employment_status: "Regular", employment_type: "Full-time" };
const PROB = { ...REG, employment_status: "Probationary" };
const PT = { ...REG, employment_type: "Part-time" };
const NT = { ...REG, employee_type: "Non-Teaching" };
const RULES = [
  ...rules(REG, { "Vacation Leave": 0, "Sick Leave": 5, "Emergency Leave": 3 }),
  ...rules(PROB, { "Vacation Leave": 0, "Sick Leave": 3, "Emergency Leave": 2 }),
  ...rules(PT, { "Vacation Leave": 0, "Sick Leave": 5, "Emergency Leave": 3 }),
  ...rules(NT, { "Vacation Leave": 5, "Sick Leave": 5, "Emergency Leave": 3 }),
];

describe("values in effect on a date", () => {
  it("before a change: the old value; on and after it: the new value; no change: the current value", () => {
    expect(classificationOn(NOW, HISTORY, "2027-02-28").employment_status).toBe("Probationary");
    expect(classificationOn(NOW, HISTORY, "2027-03-01").employment_status).toBe("Regular");
    expect(classificationOn(NOW, HISTORY, "2027-12-31").employment_status).toBe("Regular");
    expect(classificationOn(NOW, HISTORY, "2027-02-28").employee_type).toBe("Teaching");
    expect(classificationOn(NOW, [{ ...HISTORY[0], cancelled_at: "2026-11-21" }], "2027-02-28").employment_status).toBe("Regular");
  });
  it("on payroll is a true/false value", () => {
    const off = [{ field: "on_payroll", old_value: "true", new_value: "false", effective_on: "2026-12-01" }];
    expect(classificationOn({ ...NOW, on_payroll: false }, off, "2026-11-30").on_payroll).toBe(true);
    expect(classificationOn({ ...NOW, on_payroll: false }, off, "2026-12-01").on_payroll).toBe(false);
  });
  it("the year is cut where it changes", () => {
    const parts = classificationSegments(NOW, HISTORY, "2027-01-01", "2027-12-31");
    expect(parts.map((p) => [p.from, p.to, p.classification.employment_status])).toEqual([
      ["2027-01-01", "2027-02-28", "Probationary"], ["2027-03-01", "2027-12-31", "Regular"],
    ]);
  });
  it("payroll reads the pay rule of the classification on the period's first day", () => {
    const payRules = [
      { ...REG, pay_basis: "monthly", loan_eligible: true, effective_from: "2026-01-01" },
      { ...PROB, pay_basis: "monthly", loan_eligible: false, effective_from: "2026-01-01" },
    ];
    expect(payRuleFor(payRules, classificationOn(NOW, HISTORY, "2027-02-16"), "2027-02-16").loan_eligible).toBe(false);
    expect(payRuleFor(payRules, classificationOn(NOW, HISTORY, "2027-03-01"), "2027-03-01").loan_eligible).toBe(true);
  });
});

describe("leave credits per category, status and type", () => {
  it("differ by category (teachers get no vacation leave), status and type", () => {
    const year = 2026;
    const teacher = leaveEntitlement({ rules: RULES, current: REG, year, dateHired: "2020-06-01" });
    const nonTeaching = leaveEntitlement({ rules: RULES, current: NT, year, dateHired: "2020-06-01" });
    const probationary = leaveEntitlement({ rules: RULES, current: PROB, year, dateHired: "2020-06-01" });
    expect(teacher["Vacation Leave"].days).toBe(0);
    expect(nonTeaching["Vacation Leave"].days).toBe(5);
    expect(teacher["Sick Leave"].days).toBe(5);
    expect(probationary["Sick Leave"].days).toBe(3);
  });
  it("a new hire gets the share of the year from the hire date, rounded down to the half day", () => {
    // Hired Jul 1, 2026: 184 of 365 days × 5 = 2.52 → 2.5
    const e = leaveEntitlement({ rules: RULES, current: REG, year: 2026, dateHired: "2026-07-01" });
    expect(e["Sick Leave"].days).toBe(2.5);
    expect(e["Emergency Leave"].days).toBe(1.5);
  });
  it("a part-timer gets the share of its scheduled hours (20 of 40 = half)", () => {
    const e = leaveEntitlement({ rules: RULES, current: PT, year: 2026, dateHired: "2020-06-01", weeklyHours: 20, fullTimeWeeklyHours: 40 });
    expect(e["Sick Leave"].days).toBe(2.5);
    expect(e["Emergency Leave"].days).toBe(1.5);
  });
  it("Probationary → Regular on Mar 1 earns each rule for its part of the year", () => {
    const rules2027 = [...rules(REG, { "Sick Leave": 5 }, "2027-01-01"), ...rules(PROB, { "Sick Leave": 3 }, "2027-01-01")];
    const e = leaveEntitlement({ rules: rules2027, current: NOW, changes: HISTORY, year: 2027, dateHired: "2026-09-01" });
    // 59/365 × 3 + 306/365 × 5 = 0.48 + 4.19 = 4.68 → 4.5
    expect(e["Sick Leave"].days).toBe(4.5);
    expect(e["Sick Leave"].parts).toHaveLength(2);
  });
  it("a per-employee override (the latest) replaces the computed days, and says so", () => {
    const overrides = [
      { leave_type: "Sick Leave", year: 2026, days: 7, created_at: "2026-02-01T00:00:00Z" },
      { leave_type: "Sick Leave", year: 2026, days: 8, created_at: "2026-03-01T00:00:00Z" },
    ];
    const e = leaveEntitlement({ rules: RULES, current: REG, year: 2026, dateHired: "2020-06-01", overrides });
    expect(e["Sick Leave"]).toMatchObject({ days: 8, computed: 5 });
  });
  it("warns where vacation + sick + emergency is below the 5-day service incentive leave", () => {
    const low = [...RULES, ...rules({ ...PROB, employee_type: "Non-Teaching" }, { "Vacation Leave": 0, "Sick Leave": 2, "Emergency Leave": 1 })];
    const warnings = legalMinimumWarnings(low, "2026-11-20");
    expect(warnings).toContainEqual({ employee_type: "Non-Teaching", employment_status: "Probationary", employment_type: "Full-time", total: 3 });
    expect(warnings.find((w) => w.employee_type === "Teaching" && w.employment_status === "Regular" && w.employment_type === "Full-time")).toBeUndefined();
  });
});

describe("pay rules, required fields and no Substitute", () => {
  it("eligibility is refused in plain words", () => {
    const rule = { loan_eligible: false, incentive_eligible: true };
    expect(eligibilityError(rule, "loan", PROB)).toBe("Teaching · Probationary · Full-time employees are not eligible for loans (pay rules).");
    expect(eligibilityError(rule, "incentive", PROB)).toBeNull();
    expect(eligibilityError(null, "loan", PROB)).toBeNull();
  });
  it("Substitute is not a status anywhere", () => {
    expect(EMPLOYMENT_STATUS_OPTIONS).toEqual(["Regular", "Probationary", "Contractual"]);
    const sql = readFileSync("supabase/migrations/20261121010000_employee_classification.sql", "utf8");
    expect(sql).toMatch(/employment_status IN \('Regular', 'Probationary', 'Contractual'\)/);
    expect(readFileSync("src/app/hr/employee-form-dialog.jsx", "utf8")).not.toMatch(/"Substitute"/);
  });
  it("an edit cannot change category, status or type without a date and a reason", () => {
    expect(changedClassification(REG, { ...REG, employment_status: "Probationary" })).toEqual(["employment_status"]);
    expect(changedClassification(REG, REG)).toEqual([]);
    // A record with nothing on file may be filled in.
    expect(changedClassification({ employee_type: "Teaching" }, REG)).toEqual([]);
    expect(CHANGE_WITH_DATE).toMatch(/Change status or type/);
    for (const route of ["src/app/api/hr/employees/route.js", "src/app/api/admin/employees/route.js"]) {
      expect(readFileSync(route, "utf8")).toMatch(/CHANGE_WITH_DATE/);
    }
  });
  it("labels read in one line", () => {
    expect(classificationLabel(REG)).toBe("Teaching · Regular · Full-time");
  });
});

describe("a record with no status or type on file", () => {
  it("earns the default Teaching · Regular · Full-time credits, not zero", () => {
    const e = leaveEntitlement({ rules: RULES, current: { employee_type: "Teaching" }, year: 2026, dateHired: "2020-06-01" });
    expect(e["Sick Leave"].days).toBe(5);
  });
});
