// Part E step 6 (2026-11-23): rule-based incentives wait for HR.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gateRuleIncentives, ruleIncentiveBlockers } from "@/lib/payroll/incentive-recommendations";

const recs = (list) => new Map(list.map(([emp, kind, status]) => [`${emp}|${kind}`, { status }]));
const computed = { perfect_attendance: { amount: 500, reasons: ["r"] }, early_bird: { amount: 300, reasons: [] } };

describe("the gate", () => {
  it("off: paid as before, nothing recorded", () => {
    const g = gateRuleIncentives({ on: false, recs: new Map() }, "e1", computed);
    expect(g.pay).toEqual({ perfect_attendance: 500, early_bird: 300 });
    expect(g.items).toEqual([]);
  });
  it("on, no decision yet: held (₱0) and recorded as pending", () => {
    const g = gateRuleIncentives({ on: true, recs: new Map() }, "e1", computed);
    expect(g.pay).toEqual({ perfect_attendance: 0, early_bird: 0 });
    expect(g.items.map((i) => [i.kind, i.status, i.paid])).toEqual([["perfect_attendance", "pending", false], ["early_bird", "pending", false]]);
  });
  it("approved is paid, rejected never is", () => {
    const g = gateRuleIncentives({ on: true, recs: recs([["e1", "perfect_attendance", "approved"], ["e1", "early_bird", "rejected"]]) }, "e1", computed);
    expect(g.pay).toEqual({ perfect_attendance: 500, early_bird: 0 });
  });
  it("nothing computed: nothing recorded (an earlier pending one is withdrawn on save)", () => {
    const g = gateRuleIncentives({ on: true, recs: new Map() }, "e1", { perfect_attendance: { amount: 0 }, early_bird: { amount: 0 } });
    expect(g.items).toEqual([]);
  });
});

describe("run submit", () => {
  const entry = (paid, status) => ({ employee_id: "e1", employee_name: "Ana", payroll: { rule_incentives: { items: [{ kind: "perfect_attendance", amount: 500, paid, status }] } } });
  it("blocked while HR hasn't decided", () => {
    expect(ruleIncentiveBlockers([entry(false, "pending")], recs([["e1", "perfect_attendance", "pending"]])).waiting).toEqual(["Ana (Perfect Attendance)"]);
  });
  it("approved after the payslip was computed: recompute first", () => {
    expect(ruleIncentiveBlockers([entry(false, "pending")], recs([["e1", "perfect_attendance", "approved"]])).recompute).toHaveLength(1);
  });
  it("paid, or rejected: nothing blocks", () => {
    expect(ruleIncentiveBlockers([entry(true, "approved")], recs([["e1", "perfect_attendance", "approved"]]))).toEqual({ waiting: [], recompute: [] });
    expect(ruleIncentiveBlockers([entry(false, "rejected")], recs([["e1", "perfect_attendance", "rejected"]]))).toEqual({ waiting: [], recompute: [] });
  });
});

describe("wiring", () => {
  it("payroll gates both incentives, HR decides through the database, never their own", () => {
    const route = readFileSync("src/app/api/accountant/payroll/route.js", "utf8");
    expect(route).toMatch(/finalAmounts\.perfect_attendance = ruleGate\.pay\.perfect_attendance/);
    expect(route).toMatch(/const earlyBirdWinner = ruleGate\.pay\.early_bird > 0 \? earlyBirdComputed : null/);
    expect(route).toMatch(/syncIncentiveRecommendations\(supabase/);
    const sql = readFileSync("supabase/migrations/20261124080000_incentive_recommendations.sql", "utf8");
    expect(sql).toMatch(/v_row\.employee_id = p_actor/);
    expect(sql).toMatch(/v_actor\.role <> 'hr'/);
    expect(readFileSync("src/lib/payroll/run-service.js", "utf8")).toMatch(/ruleIncentiveBlockers\(finals/);
  });
});
