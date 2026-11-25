// Release 4 (2026-11-26, the owner's full-system check): leave types, profile, payslip leave line,
// bulk selections, Assign, Admin headings, additional pay types.
import { readSource } from "./helpers/read-source.js";
import { describe, expect, it } from "vitest";
import { BEREAVEMENT_LEAVE, BEREAVEMENT_RELATIONSHIPS, CREDIT_LEAVE_TYPES, bereavementRefusal, leavePoolText, statutoryRefusal } from "@/lib/employees/classification";
import { recommendFrom } from "@/lib/automation/leave-recommendations";
import { leaveWithPayText, payslipTables, payslipTotalsCheck } from "@/lib/payroll/payslip-tables";

const src = (p) => readSource(p);

describe("1. leave types: statutory and school policy, never the credits pool", () => {
  const bereavement = { leave_type: BEREAVEMENT_LEAVE, enabled: true, days: 3, basis: "event", eligibility: "any", max_events: null, source: "school" };
  const maternity = { leave_type: "Maternity Leave", enabled: true, days: 105, basis: "event", eligibility: "female", max_events: null, source: "statutory" };
  const paternity = { leave_type: "Paternity Leave", enabled: true, days: 7, basis: "event", eligibility: "married_male", max_events: 4, source: "statutory" };

  it("the form says which pool a type uses", () => {
    expect(leavePoolText(null)).toBe("Uses your leave credits (one yearly total for vacation, sick and emergency leave).");
    expect(leavePoolText(bereavement)).toBe("School policy: up to 3 days each time. Not from your leave credits.");
    expect(leavePoolText(maternity)).toBe("Statutory: up to 105 days each time. Not from your leave credits.");
    expect(leavePoolText({ ...maternity, days: 1, basis: "year" })).toBe("Statutory: up to 1 day a year. Not from your leave credits.");
  });

  it("bereavement: any employee, at most its days, not a credits type", () => {
    expect(CREDIT_LEAVE_TYPES).not.toContain(BEREAVEMENT_LEAVE);
    expect(statutoryRefusal(bereavement, { sex: "", civil_status: "" }, { days: 3 })).toBeNull();
    expect(statutoryRefusal(bereavement, { sex: "male" }, { days: 4 })).toBe("Bereavement Leave is at most 3 days.");
    // A setting: HR changes the days, the rule follows.
    expect(statutoryRefusal({ ...bereavement, days: 5 }, {}, { days: 5 })).toBeNull();
  });

  it("bereavement details: relationship and date of death (not in the future; the leave starts on or after it)", () => {
    expect(Object.keys(BEREAVEMENT_RELATIONSHIPS)).toEqual(["spouse", "parent", "child", "sibling"]);
    const today = "2026-11-26";
    expect(bereavementRefusal({ relationship: "cousin", eventDate: "2026-11-24", startDate: "2026-11-25", today })).toMatch(/spouse, parent, child or sibling/);
    expect(bereavementRefusal({ relationship: "parent", eventDate: "", startDate: "2026-11-25", today })).toBe("Enter the date of death.");
    expect(bereavementRefusal({ relationship: "parent", eventDate: "2026-11-27", startDate: "2026-11-27", today })).toBe("The date of death cannot be in the future.");
    expect(bereavementRefusal({ relationship: "parent", eventDate: "2026-11-24", startDate: "2026-11-23", today })).toBe("The leave starts on or after the date of death.");
    expect(bereavementRefusal({ relationship: "parent", eventDate: "2026-11-24", startDate: "2026-11-25", today })).toBeNull();
  });

  it("maternity / paternity keep their eligibility (sex, civil status, deliveries)", () => {
    expect(statutoryRefusal(maternity, { sex: "Male" }, { days: 0 })).toBe("Maternity Leave is for female employees.");
    expect(statutoryRefusal(maternity, { sex: "Female" }, { days: 0 })).toBeNull();
    expect(statutoryRefusal(paternity, { sex: "Male", civil_status: "Single" }, { days: 0 })).toBe("Paternity Leave is for married male employees.");
    expect(statutoryRefusal(paternity, { sex: "Male", civil_status: "Married" }, { days: 0, priorEvents: 4 })).toMatch(/first 4 times only/);
  });

  it("the system's check: a per-event type never reads the credits pool; bereavement is not 'filed late'", () => {
    const leave = { leave_type: BEREAVEMENT_LEAVE, pay_status: "with_pay", start_date: "2026-11-25", end_date: "2026-11-27" };
    const rec = recommendFrom({ leave, remaining: 0, filedKey: "2026-11-25" });
    expect(rec.reasons).toContain("Bereavement Leave: per event, not from the leave credits");
    expect(rec.reasons).toContain("Bereavement: not filed ahead (from the date of death)");
    expect(rec.warnings.join(" ")).not.toMatch(/Credits|Filed/);
    // A credits type is unchanged.
    const vac = recommendFrom({ leave: { ...leave, leave_type: "Vacation Leave", start_date: "2026-12-10", end_date: "2026-12-10" }, remaining: 3, filedKey: "2026-11-25" });
    expect(vac.reasons[0]).toBe("Credits: enough (3 paid days left)");
  });

  it("the migration: Bereavement row (school, 3 days), relationship and date columns; additive", () => {
    const sql = src("supabase/migrations/20261126030000_bereavement_leave.sql");
    expect(sql).toMatch(/\('Bereavement Leave', TRUE, 3, 'event', 'any', NULL,/);
    expect(sql).toMatch(/ON CONFLICT \(leave_type\) DO NOTHING/);
    expect(sql).toMatch(/event_relationship IN \('spouse', 'parent', 'child', 'sibling'\)/);
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN)\b|\bDELETE\b/);
  });

  it("the server: bereavement skips the 7-day rule only after its details pass", () => {
    const route = src("src/app/api/employee/leave-requests/route.js");
    expect(route).toMatch(/\} else if \(leaveType === BEREAVEMENT_LEAVE\) \{\n\s+\/\/ Bereavement[^\n]*\n\s+const refused = bereavementRefusal/);
    expect(route).toMatch(/balance\.statutory_needs_profile = !person\.sex \|\| !person\.civil_status;/);
  });
});

describe("3. payslip: paid leave in the Earnings (screen, PDF and print share these tables)", () => {
  const groups = (extra = {}) => ({
    line_groups: {
      half: "second",
      groups: [{ lines: [
        { key: "basic", label: "Basic salary", amount: 10000, sign: "+" },
        { key: "leave_conversion", label: "Leave conversion", amount: 500, sign: "+" },
        { key: "sss", label: "SSS", amount: 500, sign: "-" },
        { key: "lwop", label: "Leave without pay", amount: 300, sign: "-" },
      ] }],
      leave_with_pay_days: 2, leave_with_pay_by_type: { "Vacation Leave": 1, "Sick Leave": 1 },
      gross: 10500, total_deductions: 800, ...extra,
    },
  });

  it("the words: days and the types when stored (and they add up)", () => {
    expect(leaveWithPayText(2, { "Vacation Leave": 1, "Sick Leave": 1 })).toBe("2 days (Vacation 1, Sick 1)");
    expect(leaveWithPayText(1.5, { "Sick Leave": 1.5 })).toBe("1.5 days (Sick 1.5)");
    expect(leaveWithPayText(2, null)).toBe("2 days"); // a payslip from before (no types stored)
    expect(leaveWithPayText(2, { "Sick Leave": 1 })).toBe("2 days"); // types that do not add up are not shown
    expect(leaveWithPayText(0, {})).toBe("0 days");
  });

  it("in the Earnings, right before the leave conversion; never among the deductions; without pay stays a deduction; totals unchanged", () => {
    const t = payslipTables(groups());
    const keys = t.earnings.map((r) => r.key);
    expect(keys.slice(0, 3)).toEqual(["basic", "leave_with_pay", "leave_conversion"]);
    // 2026-11-25: "Paid leave (2 days: …)", inside the Basic pay (a text row, never summed).
    expect(t.earnings[1]).toMatchObject({ label: "Paid leave (2 days: Vacation 1, Sick 1)", amount: 0 });
    expect(t.deductions.map((r) => r.key)).not.toContain("leave_with_pay");
    expect(t.deductions.find((r) => r.key === "lwop")).toMatchObject({ amount: 300 });
    expect(payslipTotalsCheck(t, 9700)).toEqual([]);
  });

  it("no paid leave: no row", () => {
    const t = payslipTables(groups({ leave_with_pay_days: 0, leave_with_pay_by_type: {} }));
    expect(t.earnings.map((r) => r.key)).not.toContain("leave_with_pay");
  });

  it("the payroll stores the types with the days", () => {
    const route = src("src/app/api/accountant/payroll/route.js");
    expect(route).toMatch(/leave_with_pay_by_type: leaveWithPayByType,/);
    expect(route).toMatch(/withPayByType\[type\] = \(withPayByType\[type\] \|\| 0\) \+ share;/);
  });
});

describe("8. Additional Pay: own pay types, no new Adjustment, remove pending items together", () => {
  it("a type's fields; an item's type in words", async () => {
    const { payTypeProblem, itemKindLabel, NEW_ITEM_KINDS } = await import("@/lib/payroll/pay-types");
    expect(payTypeProblem({ name: "x" })).toBe("Name the pay type (at least 2 characters).");
    expect(payTypeProblem({ name: "y".repeat(61) })).toBe("The name can be at most 60 characters.");
    expect(payTypeProblem({ name: "Club adviser", description: "d".repeat(301) })).toBe("The description can be at most 300 characters.");
    expect(payTypeProblem({ name: "Club adviser", description: "ok" })).toBeNull();
    expect(itemKindLabel({ kind: "custom", pay_type_name: "Club adviser" })).toBe("Club adviser");
    expect(itemKindLabel({ kind: "adjustment" })).toBe("Adjustment"); // old items stay readable
    expect(NEW_ITEM_KINDS).not.toContain("adjustment");
    expect(NEW_ITEM_KINDS).toContain("custom");
  });

  it("the server: Adjustment refused for new items; a custom item needs an active type and copies its tax treatment", () => {
    const route = src("src/app/api/accountant/payroll/route.js");
    expect(route).toMatch(/if \(kind === "adjustment"\) return NextResponse\.json\(\{ error: "Adjustment is no longer offered\./);
    expect(route).toMatch(/if \(!payType\.active\) return NextResponse\.json/);
    expect(route).toMatch(/non_taxable: kind === "custom" \? payType\.taxable === false : false,/);
    // Tax: a non-taxable custom item is in the non-taxable earnings; a taxable one only in the gross.
    expect(route).toMatch(/const nonTaxable = toAmount\(subsidy\.non_taxable \+ \(bonuses\?\.exempt \|\| 0\) \+ adjustmentNonTaxable \+ customNonTaxable \+/);
    expect(route).toMatch(/adjustmentTaxable \+ adjustmentNonTaxable \+ customTaxable \+ customNonTaxable\);/);
  });

  it("Remove selected: only pending items; all checked first; each logged", () => {
    const route = src("src/app/api/accountant/payroll/route.js");
    const handler = route.slice(route.indexOf("async function handleRemovePendingItems"), route.indexOf("/** PATCH { action: \"archive_monthly_item\""));
    expect(handler).toMatch(/!== "pending"\) \{\n\s+return NextResponse\.json\(\{[^\n]*Nothing was removed\.`, code: "not_pending" \}, \{ status: 409 \}\);/);
    expect(handler).toMatch(/\.eq\("approval_status", "pending"\)\.eq\("archived", false\)/);
    expect(handler).toMatch(/action: "monthly_item_archive"/);
  });

  it("the migration: the types table (RLS, no client grants), kind custom with a type, additive", () => {
    const sql = src("supabase/migrations/20261126040000_additional_pay_types.sql");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.additional_pay_types/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON public\.additional_pay_types FROM anon, authenticated;/);
    expect(sql).toMatch(/OR \(kind = 'custom' AND amount > 0 AND hours IS NULL AND pay_type_id IS NOT NULL\)/);
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN)\b|\bDELETE FROM\b|\bUPDATE public\./);
  });
});
