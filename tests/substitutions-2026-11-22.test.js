// Part C (2026-11-22): substitute teaching — pay from the schedule and taps,
// never twice; suggestions from same level / branch / tapped in / not on leave / under the cap.
import { describe, expect, it } from "vitest";
import { SUBSTITUTION_SETTINGS, computeSubstitutionPay, suggestSubstitutes, tapsConfirm, weekOf } from "@/lib/substitutions/pay";

const settings = Object.fromEntries(Object.entries(SUBSTITUTION_SETTINGS).map(([k, d]) => [k, d.fallback]));
const rates = { hourly: 183.91, overtime_regular_pct: 125, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30 };
const sub = (o = {}) => ({ id: "s1", sub_date: "2026-11-18", start_time: "10:00", end_time: "11:00", periods: 1, absent_name: "T. Reyes", class_section: "Grade 5", ...o });
const pay = (subs, extra = {}) => computeSubstitutionPay({
  subs, tapsOf: () => ({ in: 7 * 60, out: 16 * 60 }), rates, settings, ...extra,
});

// 2026-11-26 (school policy): a substitution is paid as OVERTIME on the periods covered; the ₱150 allowance,
// the inside / outside split and the overload part are gone (earlier payslips keep their lines).
describe("substitution pay as overtime (2026-11-26)", () => {
  it("2 periods → 2 h × the hourly rate × 125%, with the payslip words", () => {
    const { lines } = pay([sub({ periods: 2, end_time: "12:00" })]);
    expect(lines).toEqual([expect.objectContaining({ kind: "overtime_substitution", minutes: 120, rate_pct: 125, amount: 459.78,
      note: "Overtime (substitution): 2 h × ₱183.91 × 125%, covering T. Reyes, Grade 5 (Nov 18)" })]);
  });

  it("the period length is a setting (default 1 h)", () => {
    expect(settings.substitution_period_hours).toBe(1);
    expect(pay([sub({ periods: 2 })], { settings: { ...settings, substitution_period_hours: 0.75 } }).lines[0].minutes).toBe(90);
  });

  it("no taps (or taps that do not cover the class): not paid, listed for HR", () => {
    expect(pay([sub()], { tapsOf: () => null })).toEqual({ lines: [], unconfirmed: [{ id: "s1", sub_date: "2026-11-18" }], overlaps: [] });
    expect(tapsConfirm(sub(), { in: 7 * 60, out: 10 * 60 + 30 })).toBe(false);
    expect(tapsConfirm(sub(), { in: 10 * 60 + 10, out: 16 * 60 })).toBe(true); // within the grace
  });

  it("overlapping approved overtime is paid once: the covered minutes leave the substitution line, flagged", () => {
    const { lines, overlaps } = pay([sub({ periods: 2, end_time: "12:00" })], { overtimeOf: () => [[11 * 60, 13 * 60]] });
    expect(overlaps).toEqual([{ id: "s1", sub_date: "2026-11-18", minutes: 60 }]);
    expect(lines[0]).toMatchObject({ minutes: 60, amount: 229.89 });
    expect(lines[0].note).toMatch(/overlapping overtime paid once/);
  });

  it("holidays use the rates table (× 130%); a rest day is the rest-day premium, 130% (2026-11-26)", () => {
    expect(pay([sub()], { dayKindOf: () => "holiday" }).lines[0]).toMatchObject({ rate_pct: 260, amount: 478.17 });
    expect(pay([sub()], { dayKindOf: () => "special" }).lines[0]).toMatchObject({ rate_pct: 169, amount: 310.81 });
    // No rate row saved: the Labor Code's 30%.
    expect(pay([sub()], { dayKindOf: () => "rest_day" }).lines[0]).toMatchObject({ rate_pct: 130, amount: 239.08 });
    expect(pay([sub()], { dayKindOf: () => "rest_day" }).lines[0].note).toBe("Overtime (substitution): 1 h × ₱183.91 × 130%, covering T. Reyes, Grade 5 (Nov 18)");
    // The rates table's value wins.
    expect(pay([sub()], { dayKindOf: () => "rest_day", rates: { ...rates, rest_day_premium_pct: 35 } }).lines[0]).toMatchObject({ rate_pct: 135, amount: 248.28 });
    // A regular day is unchanged.
    expect(pay([sub()], { dayKindOf: () => "regular" }).lines[0]).toMatchObject({ rate_pct: 125, amount: 229.89 });
  });

  it("a rest day past 8 h (all that day's substitutions): those hours at 169%", () => {
    const subs = [sub({ id: "a", start_time: "07:00", end_time: "14:00", periods: 7 }), sub({ id: "b", start_time: "14:00", end_time: "17:00", periods: 3 })];
    const { lines } = pay(subs, { dayKindOf: () => "rest_day", tapsOf: () => ({ in: 6 * 60 + 50, out: 17 * 60 + 10 }) });
    expect(lines[0]).toMatchObject({ minutes: 420, rate_pct: 130, amount: 1673.58 });
    expect(lines[0].past_8h_minutes).toBeUndefined();
    // 7 h + 3 h = 10 h: 1 h at 130%, 2 h at 169%.
    expect(lines[1]).toMatchObject({ minutes: 180, rate_pct: 130, past_8h_minutes: 120, past_8h_pct: 169, amount: 860.7 });
    expect(lines[1].note).toMatch(/; 2 h past 8 h on the rest day at 169%$/);
  });

  it("substitution hours do not count toward the overtime caps (setting, off)", () => {
    expect(settings.substitution_counts_toward_ot_cap).toBe("off");
    expect(SUBSTITUTION_SETTINGS.substitution_fixed_per_period).toBeUndefined();
  });

  it("weeks start on Monday", () => {
    expect(weekOf("2026-11-05")).toBe("2026-11-02");
    expect(weekOf("2026-11-08")).toBe("2026-11-02");
    expect(weekOf("2026-11-09")).toBe("2026-11-09");
  });
});

describe("the payslip line (Part C)", () => {
  it("each substitution part is its own Earnings line, separate from Overload", async () => {
    const { buildLineGroups } = await import("@/lib/payroll/line-tags");
    const { groups } = buildLineGroups({ additions: {
      basic: { amount: 15000 },
      substitutions: [{ amount: 459.78, note: "Overtime (substitution): 2 h × ₱183.91 × 125%, covering T. Reyes, Grade 5 (Nov 18)" }],
      overload: { amount: 500, hours: 2, rate: 250 },
    } });
    const additions = groups.find((g) => g.key === "additions").lines;
    expect(additions.map((l) => [l.key, l.label, l.amount])).toEqual([
      ["basic", "Basic pay", 15000],
      ["overload", "Overload pay (2 h)", 500],
      ["substitution-0", "Overtime (substitution): 2 h × ₱183.91 × 125%, covering T. Reyes, Grade 5 (Nov 18)", 459.78],
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

describe("AWOL 1st notice template (Part D)", () => {
  it("fills the fields; unknown fields stay as written", async () => {
    const { fillNotice } = await import("@/lib/awol/cases");
    expect(fillNotice("To {employee_name}: reply by {reply_by}. {unknown}", { employee_name: "Abe", reply_by: "March 8, 2027" })).toBe("To Abe: reply by March 8, 2027. {unknown}");
  });
});
