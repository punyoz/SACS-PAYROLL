// Release 4 (2026-11-26, the owner's full-system check): leave types, profile, payslip leave line,
// bulk selections, Assign, Admin headings, additional pay types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BEREAVEMENT_LEAVE, BEREAVEMENT_RELATIONSHIPS, CREDIT_LEAVE_TYPES, bereavementRefusal, leavePoolText, statutoryRefusal } from "@/lib/employees/classification";
import { recommendFrom } from "@/lib/automation/leave-recommendations";

const src = (p) => readFileSync(p, "utf8");

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
