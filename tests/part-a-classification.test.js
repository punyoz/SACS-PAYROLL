/**
 * Part A (panel revisions 2026-11-20, 20261121010000): category, employment
 * status and type; dated history; leave credits per classification; pay rules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHANGE_WITH_DATE, CREDIT_LEAVE_TYPES, changedClassification, statutoryRefusal, classificationLabel, classificationOn, classificationSegments,
  eligibilityError, leaveEntitlement, legalMinimumWarnings, payRuleFor,
} from "@/lib/employees/classification";
import { EMPLOYMENT_STATUS_OPTIONS, EMPLOYMENT_TYPE_OPTIONS } from "@/lib/employees/record";

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
    // Under 1 year of service (hired Jan 1): the Probationary rule. (1+ year earns the Regular one: see below.)
    const probationary = leaveEntitlement({ rules: RULES, current: PROB, year, dateHired: "2026-01-01" });
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
  it("no part-time pro-ration (2026-11-23): an old Part-time value earns the Category × Status credits", () => {
    const pt = leaveEntitlement({ rules: RULES, current: PT, year: 2026, dateHired: "2020-06-01" });
    const ft = leaveEntitlement({ rules: RULES, current: REG, year: 2026, dateHired: "2020-06-01" });
    expect(pt["Sick Leave"].days).toBe(ft["Sick Leave"].days);
    expect(pt["Emergency Leave"].days).toBe(ft["Emergency Leave"].days);
  });
  it("Probationary → Regular on Mar 1 earns each rule for its part of the year", () => {
    const rules2027 = [...rules(REG, { "Sick Leave": 5 }, "2027-01-01"), ...rules(PROB, { "Sick Leave": 3 }, "2027-01-01")];
    const e = leaveEntitlement({ rules: rules2027, current: NOW, changes: HISTORY, year: 2027, dateHired: "2026-09-01" });
    // 59/365 × 3 + 306/365 × 5 = 0.48 + 4.19 = 4.68 → 4.5
    expect(e["Sick Leave"].days).toBe(4.5);
    // Mar 1 (Regular) and the Sep 1 service anniversary (already Regular: same rule) cut the year.
    expect(e["Sick Leave"].parts).toHaveLength(3);
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
    expect(eligibilityError(rule, "loan", PROB)).toBe("Teaching · Probationary employees are not eligible for loans (pay rules).");
    expect(eligibilityError(rule, "incentive", PROB)).toBeNull();
    expect(eligibilityError(null, "loan", PROB)).toBeNull();
  });
  it("Substitute is not a status anywhere", () => {
    expect(EMPLOYMENT_STATUS_OPTIONS).toEqual(["Regular", "Probationary", "Provisional", "Contractual"]);
    const sql = readFileSync("supabase/migrations/20261121010000_employee_classification.sql", "utf8");
    expect(sql).toMatch(/employment_status IN \('Regular', 'Probationary', 'Contractual'\)/);
    expect(readFileSync("src/app/hr/employee-form-dialog.jsx", "utf8")).not.toMatch(/"Substitute"/);
  });
  it("an edit cannot change category, status or type without a date and a reason", () => {
    expect(changedClassification(REG, { ...REG, employment_status: "Probationary" })).toEqual(["employment_status"]);
    expect(changedClassification(REG, REG)).toEqual([]);
    // A record with nothing on file may be filled in.
    expect(changedClassification({ employee_type: "Teaching" }, REG)).toEqual([]);
    expect(CHANGE_WITH_DATE).toMatch(/Change status/);
    for (const route of ["src/app/api/hr/employees/route.js", "src/app/api/admin/employees/route.js"]) {
      expect(readFileSync(route, "utf8")).toMatch(/CHANGE_WITH_DATE/);
    }
  });
  it("labels read in one line", () => {
    expect(classificationLabel(REG)).toBe("Teaching · Regular");
  });
});

describe("a record with no status or type on file", () => {
  it("earns the default Teaching · Regular · Full-time credits, not zero", () => {
    const e = leaveEntitlement({ rules: RULES, current: { employee_type: "Teaching" }, year: 2026, dateHired: "2020-06-01" });
    expect(e["Sick Leave"].days).toBe(5);
  });
});

describe("statutory leave: per event, with eligibility (not yearly credits)", () => {
  const MAT = { leave_type: "Maternity Leave", enabled: true, days: 105, eligibility: "female", max_events: null };
  const PAT = { leave_type: "Paternity Leave", enabled: true, days: 7, eligibility: "married_male", max_events: 4 };
  const SOLO = { leave_type: "Solo Parent Leave", enabled: false, days: 7, eligibility: "any", max_events: null };
  it("maternity: female employees, up to the set days", () => {
    expect(statutoryRefusal(MAT, { sex: "Female" }, { days: 105 })).toBeNull();
    expect(statutoryRefusal(MAT, { sex: "Male" }, { days: 5 })).toMatch(/female employees/);
    expect(statutoryRefusal(MAT, { sex: "Female" }, { days: 106 })).toMatch(/at most 105 days/);
  });
  it("paternity: married male employees, the first 4 deliveries", () => {
    expect(statutoryRefusal(PAT, { sex: "Male", civil_status: "Married" }, { days: 7, priorEvents: 3 })).toBeNull();
    expect(statutoryRefusal(PAT, { sex: "Male", civil_status: "Married" }, { days: 7, priorEvents: 4 })).toMatch(/first 4 times only; this would be time 5/);
    expect(statutoryRefusal(PAT, { sex: "Male", civil_status: "Single" }, { days: 7 })).toMatch(/married male/);
  });
  it("a leave the school has not turned on is refused", () => {
    expect(statutoryRefusal(SOLO, { sex: "Female" }, { days: 1 })).toMatch(/not offered/);
  });
  it("maternity and paternity are not in the yearly credits", () => {
    expect(CREDIT_LEAVE_TYPES).toEqual(["Vacation Leave", "Sick Leave", "Emergency Leave"]);
  });
});

describe("no part-time employees (2026-11-23)", () => {
  it("the import template has no Employment type column; an old template's column is read and ignored", async () => {
    const { importTemplate, IMPORT_COLUMNS, parseImport } = await import("@/lib/employees/csv-import");
    expect(IMPORT_COLUMNS.map(([k]) => k)).not.toContain("employment_type");
    if (importTemplate) expect(importTemplate()).not.toMatch(/Employment type/i);
    if (parseImport) {
      const header = IMPORT_COLUMNS.map(([, label]) => (label.includes(",") ? `"${label}"` : label)).join(",");
      const { unknown } = parseImport(`${header},Employment type * (Full-time / Part-time)\n`);
      expect(unknown).toEqual([]);
    }
  });
  it("payroll has no per-hour path; rules are Category × Status, monthly salary only", () => {
    const route = readFileSync("src/app/api/accountant/payroll/route.js", "utf8");
    expect(route).not.toMatch(/pay_basis_not_supported/);
    expect(readFileSync("src/app/api/hr/classification-rules/route.js", "utf8")).toMatch(/Employees are paid a monthly salary/);
    expect(EMPLOYMENT_TYPE_OPTIONS).toEqual(["Full-time"]);
  });
});

describe("Provisional, Maintenance and the 5 / 3 credit defaults (2026-11-23)", () => {
  const R = (status, days) => ["Vacation Leave", "Sick Leave"].map((leave_type) => ({ leave_type, employee_type: "Teaching", employment_status: status, employment_type: "Full-time", days_per_year: days, effective_from: "2026-01-01" }));
  const rules = [...R("Regular", 5), ...R("Provisional", 3), ...R("Probationary", 3)];
  it("Provisional is a status; Maintenance is a POSITION (2026-11-24), the old group is never written", async () => {
    expect(EMPLOYMENT_STATUS_OPTIONS).toContain("Provisional");
    const { normalizeEmployeeFields } = await import("@/lib/employees/record");
    if (normalizeEmployeeFields) {
      // An old "Group" value (a form or a CSV column) is ignored.
      expect(normalizeEmployeeFields({ employee_type: "Non-Teaching", staff_group: "Maintenance" })).not.toHaveProperty("staff_group");
      expect(normalizeEmployeeFields({ employee_type: "Non-Teaching", position: "Maintenance" }).position).toBe("Maintenance");
    }
    expect(readFileSync("supabase/migrations/20261124200000_leave_pool_maintenance_awol_card.sql", "utf8")).toMatch(/SELECT 'Maintenance', 'System' WHERE NOT EXISTS/);
    const sql = readFileSync("supabase/migrations/20261124110000_provisional_maintenance_leave_defaults.sql", "utf8");
    expect(sql).toMatch(/'Regular', 'Probationary', 'Provisional', 'Contractual'/);
    expect(sql).toMatch(/staff_group IN \('Maintenance'\)/);
  });
  it("a new Provisional hire earns 3; after 1 year of service the Regular 5, pro-rated from that date", () => {
    const fresh = leaveEntitlement({ rules, current: { employee_type: "Teaching", employment_status: "Provisional" }, year: 2027, dateHired: "2026-12-01" });
    // Dec 1 2026 + 12 months = Dec 1 2027: 334 days at 3 + 31 days at 5 = 2.75 + 0.42 = 3.17 -> 3
    expect(fresh["Vacation Leave"].days).toBe(3);
    expect(fresh["Vacation Leave"].parts).toHaveLength(2);
    const served = leaveEntitlement({ rules, current: { employee_type: "Teaching", employment_status: "Provisional" }, year: 2027, dateHired: "2025-01-01" });
    expect(served["Sick Leave"].days).toBe(5);
    const regular = leaveEntitlement({ rules, current: { employee_type: "Teaching", employment_status: "Regular" }, year: 2027, dateHired: "2026-12-01" });
    expect(regular["Vacation Leave"].days).toBe(5);
  });
});
