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

describe("timing: only once the cutoff's attendance is complete (2026-11-23)", () => {
  it("open: on track so far, held, never sent to HR; closed from the day after at 00:10 Manila", async () => {
    const { cutoffClosed, ruleIncentiveNote } = await import("@/lib/payroll/incentive-recommendations");
    const g = gateRuleIncentives({ on: true, recs: new Map() }, "e1", computed, { closed: false });
    expect(g.pay).toEqual({ perfect_attendance: 0, early_bird: 0 });
    expect(g.items.map((i) => i.status)).toEqual(["on_track", "on_track"]);
    expect(ruleIncentiveNote({ items: g.items }, "perfect_attendance")).toMatch(/on track so far/);
    // Window ends Nov 26: Nov 27 00:05 Manila (close running) is still open; 00:10 is closed.
    expect(cutoffClosed("2026-11-26", new Date("2026-11-26T16:05:00Z"))).toBe(false);
    expect(cutoffClosed("2026-11-26", new Date("2026-11-26T16:10:00Z"))).toBe(true);
    expect(cutoffClosed("2026-11-26", new Date("2026-11-20T02:00:00Z"))).toBe(false);
  });
  it("a Final computed while the cutoff was open must be recomputed before the run is submitted", () => {
    const e = { employee_id: "e1", employee_name: "Ana", payroll: { rule_incentives: { closed: false, items: [{ kind: "perfect_attendance", amount: 500, paid: false, status: "on_track" }] } } };
    expect(ruleIncentiveBlockers([e], new Map()).recompute).toEqual(["Ana (Perfect Attendance: computed before the cutoff closed)"]);
  });
  it("a draft saved while open sends nothing (the sync skips it)", () => {
    const src = readFileSync("src/lib/payroll/incentive-recommendations.js", "utf8");
    expect(src).toMatch(/e\.payroll\.rule_incentives\.closed !== false/);
  });
});

describe("Perfect Attendance paid automatically (owner decision 2026-11-25)", () => {
  const auto = (list = []) => ({ on: true, auto: true, recs: recs(list) });
  it("both halves: paid from attendance without waiting for HR; Early Bird still waits for HR", () => {
    for (const half of ["1st", "2nd"]) {
      const g = gateRuleIncentives(auto(), `e-${half}`, computed);
      expect(g.pay).toEqual({ perfect_attendance: 500, early_bird: 0 });
      expect(g.items.map((i) => [i.kind, i.status, i.paid])).toEqual([["perfect_attendance", "auto", true], ["early_bird", "pending", false]]);
    }
  });
  it("HR undid it (rejected): not paid; a recompute keeps it unpaid", () => {
    const g = gateRuleIncentives(auto([["e1", "perfect_attendance", "rejected"]]), "e1", computed);
    expect(g.pay.perfect_attendance).toBe(0);
    expect(g.items[0]).toMatchObject({ kind: "perfect_attendance", status: "rejected", paid: false });
  });
  it("not earned (a late, an absence…): nothing paid, nothing recorded", () => {
    const g = gateRuleIncentives(auto(), "e1", { perfect_attendance: { amount: 0 }, early_bird: { amount: 0 } });
    expect(g.items).toEqual([]);
  });
  it("still waits while the cutoff is open (attendance not complete)", () => {
    const g = gateRuleIncentives(auto(), "e1", computed, { closed: false });
    expect(g.pay.perfect_attendance).toBe(0);
    expect(g.items[0].status).toBe("on_track");
  });
  it("never blocks the run (HR does not decide it first)", () => {
    const entry = { employee_id: "e1", employee_name: "Ana", payroll: { rule_incentives: { auto: true, items: [{ kind: "perfect_attendance", amount: 500, paid: true, status: "auto" }] } } };
    expect(ruleIncentiveBlockers([entry], new Map())).toEqual({ waiting: [], recompute: [] });
    expect(ruleIncentiveBlockers([entry], recs([["e1", "perfect_attendance", "approved"]]))).toEqual({ waiting: [], recompute: [] });
  });
  it("periods before the setting keep HR's approval (no auto flag)", () => {
    expect(gateRuleIncentives({ on: true, auto: false, recs: new Map() }, "e1", computed).pay.perfect_attendance).toBe(0);
  });
});
