// Part C (2026-11-22): substitute teaching — pay from the schedule and taps,
// never twice; suggestions from same level / branch / tapped in / not on leave / under the cap.
import { describe, expect, it } from "vitest";
import { SUBSTITUTION_SETTINGS, computeSubstitutionPay, suggestSubstitutes, tapsConfirm, weekOf } from "@/lib/substitutions/pay";

const settings = Object.fromEntries(Object.entries(SUBSTITUTION_SETTINGS).map(([k, d]) => [k, d.fallback]));
const rates = { hourly: 183.91, overload_premium_pct: 0, overtime_regular_pct: 125 };
const sub = (o = {}) => ({ id: "s1", sub_date: "2026-11-05", start_time: "10:00", end_time: "11:00", periods: 1, absent_name: "T. Reyes", class_section: "Grade 5", ...o });
const shift = { start: 7 * 60, end: 16 * 60 };
const pay = (subs, extra = {}) => computeSubstitutionPay({
  subs, shiftOf: () => shift, tapsOf: () => ({ in: 7 * 60, out: 16 * 60 }), scheduledHoursOfWeek: () => 0, rates, settings, ...extra,
});

describe("substitution pay (Part C)", () => {
  it("inside the substitute's shift: ₱150 a period, with the payslip words", () => {
    const { lines } = pay([sub({ periods: 2, end_time: "12:00" })]);
    expect(lines).toEqual([expect.objectContaining({ kind: "allowance", amount: 300, note: "Substitution: 2 periods × ₱150, covering T. Reyes, Grade 5 (Nov 5)" })]);
  });

  it("outside the shift: overtime at 125% of hourly; no separate overtime request", () => {
    const { lines } = pay([sub({ start_time: "16:00", end_time: "17:00" })], { tapsOf: () => ({ in: 7 * 60, out: 17 * 60 }) });
    expect(lines).toEqual([expect.objectContaining({ kind: "overtime", minutes: 60, amount: 229.89 })]);
  });

  it("straddling the shift end: split inside / outside, each minute paid once", () => {
    const { lines } = pay([sub({ start_time: "15:30", end_time: "16:30", periods: 2 })], { tapsOf: () => ({ in: 7 * 60, out: 17 * 60 }) });
    expect(lines.map((l) => [l.kind, l.minutes])).toEqual([["allowance", 30], ["overtime", 30]]);
    expect(lines.reduce((s, l) => s + l.minutes, 0)).toBe(60);
  });

  it("above the weekly standard load: the excess at the overload rate instead", () => {
    // 39.5 h scheduled that week, standard 40 h: a 1-hour class is 30 min regular + 30 min overload.
    const { lines } = pay([sub()], { scheduledHoursOfWeek: () => 39.5 });
    expect(lines.map((l) => [l.kind, l.minutes])).toEqual([["allowance", 30], ["overload", 30]]);
    expect(lines.find((l) => l.kind === "overload").amount).toBe(91.96);
    // The week's running total carries to the next substitution: all overload now.
    const two = pay([sub(), sub({ id: "s2", sub_date: "2026-11-06" })], { scheduledHoursOfWeek: () => 39.5 });
    expect(two.lines.filter((l) => l.source_id === "s2").map((l) => l.kind)).toEqual(["overload"]);
  });

  it("no taps (or taps that do not cover it): not paid, listed as unconfirmed", () => {
    expect(pay([sub()], { tapsOf: () => null })).toEqual({ lines: [], unconfirmed: [{ id: "s1", sub_date: "2026-11-05" }] });
    expect(tapsConfirm(sub(), { in: 7 * 60, out: 10 * 60 + 30 })).toBe(false);
    expect(tapsConfirm(sub(), { in: 10 * 60 + 10, out: 16 * 60 })).toBe(true); // within the grace
  });

  it("other allowance modes: own hourly × hours, or a % of it", () => {
    expect(pay([sub()], { settings: { ...settings, substitution_rate_mode: "hourly" } }).lines[0].amount).toBe(183.91);
    expect(pay([sub()], { settings: { ...settings, substitution_rate_mode: "pct", substitution_pct: 50 } }).lines[0].amount).toBe(91.96);
  });

  it("weeks start on Monday", () => {
    expect(weekOf("2026-11-05")).toBe("2026-11-02");
    expect(weekOf("2026-11-08")).toBe("2026-11-02");
    expect(weekOf("2026-11-09")).toBe("2026-11-09");
  });
});

describe("substitute suggestions (Part C)", () => {
  const absent = { id: "a", branch_id: "b1", employee_level: "Elementary" };
  const people = [
    { id: "a", full_name: "Absent", branch_id: "b1", employee_level: "Elementary", employee_type: "Teaching" },
    { id: "p1", full_name: "Pia", branch_id: "b1", employee_level: "Elementary", employee_type: "Teaching" },
    { id: "p2", full_name: "Ben", branch_id: "b1", employee_level: "Elementary", employee_type: "Teaching" },
    { id: "p3", full_name: "Hi-level", branch_id: "b1", employee_level: "High School", employee_type: "Teaching" },
    { id: "p4", full_name: "Other branch", branch_id: "b2", employee_level: "Elementary", employee_type: "Teaching" },
    { id: "p5", full_name: "Clerk", branch_id: "b1", employee_level: "Elementary", employee_type: "Non-Teaching" },
    { id: "p6", full_name: "No tap", branch_id: "b1", employee_level: "Elementary", employee_type: "Teaching" },
    { id: "p7", full_name: "On leave", branch_id: "b1", employee_level: "Elementary", employee_type: "Teaching" },
  ];
  it("same level and branch, Teaching, tapped in, not on leave, under the cap; fewest periods first", () => {
    const out = suggestSubstitutes({ absent, people, tapped: new Set(["p1", "p2", "p3", "p4", "p5", "p7"]), onLeave: new Set(["p7"]), weekPeriods: new Map([["p1", 4], ["p2", 1]]), periods: 1, cap: 5 });
    expect(out.map((p) => p.id)).toEqual(["p2", "p1"]);
    const capped = suggestSubstitutes({ absent, people, tapped: new Set(["p1", "p2"]), onLeave: new Set(), weekPeriods: new Map([["p1", 4], ["p2", 1]]), periods: 2, cap: 5 });
    expect(capped.map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("the payslip line (Part C)", () => {
  it("each substitution part is its own Earnings line, separate from Overload", async () => {
    const { buildLineGroups } = await import("@/lib/payroll/line-tags");
    const { groups } = buildLineGroups({ additions: {
      basic: { amount: 15000 },
      substitutions: [{ amount: 300, note: "Substitution: 2 periods × ₱150, covering T. Reyes, Grade 5 (Nov 5)" }],
      overload: { amount: 500, hours: 2, rate: 250 },
    } });
    const additions = groups.find((g) => g.key === "additions").lines;
    expect(additions.map((l) => [l.key, l.label, l.amount])).toEqual([
      ["basic", "Basic pay", 15000],
      ["overload", "Overload pay (2 h)", 500],
      ["substitution-0", "Substitution: 2 periods × ₱150, covering T. Reyes, Grade 5 (Nov 5)", 300],
    ]);
  });
});

describe("late approvals (Part C)", () => {
  it("approved after its cutoff was processed without it → the next payslip; not processed yet, or already paid → not late", async () => {
    const { lateSubstitutions } = await import("@/lib/substitutions/pay");
    const entry = (o = {}) => ({ id: "e1", employee_id: "t1", status: "paid", payroll: { audit: { period: { start_key: "2026-11-01", end_key: "2026-11-15" }, lines: { incentives: [] } } }, ...o });
    const subs = [{ id: "s1", substitute_id: "t1", sub_date: "2026-11-05" }];
    expect([...lateSubstitutions(subs, [entry()])]).toEqual(["s1"]);
    expect([...lateSubstitutions(subs, [])]).toEqual([]);
    const paid = entry({ payroll: { audit: { period: { start_key: "2026-11-01", end_key: "2026-11-15" }, lines: { incentives: [{ type: "substitution", substitution_id: "s1" }] } } } });
    expect([...lateSubstitutions(subs, [paid])]).toEqual([]);
  });
});
