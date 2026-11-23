// Part E step 4 (2026-11-23): the system's leave recommendation (credits, filing
// time, calendar, staffing). Always a recommendation: HR decides.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/leave-requests/store", () => ({ leaveBalancesFor: async () => ({}) }));
const { recommendFrom, rangeDays } = await import("@/lib/automation/leave-recommendations");

const leave = (over = {}) => ({ employee_name: "Ana", leave_type: "Vacation Leave", pay_status: "with_pay", start_date: "2026-12-07", end_date: "2026-12-09", half_day: null, ...over });

describe("leave recommendation", () => {
  it("all fine: recommend approval with the reasons", () => {
    const r = recommendFrom({ leave: leave(), remaining: 5, filedKey: "2026-11-23", staffing: [{ date: "2026-12-07", pct: 90, min_pct: 80, below: false }] });
    expect(r).toMatchObject({ decision: "endorse", label: "Recommend approval", warnings: [] });
    expect(r.reasons.join(" | ")).toMatch(/Credits: enough \(5 paid days left\).*Filed 14 days ahead \(rule: 7\).*at least 90% present/);
  });

  it("over the credits, filed late, staffing low: still a recommendation, with each warning (never a refusal)", () => {
    const r = recommendFrom({ leave: leave(), remaining: 1, filedKey: "2026-12-04",
      staffing: [{ date: "2026-12-07", pct: 70, min_pct: 80, below: true }, { date: "2026-12-08", pct: 85, min_pct: 80, below: false }] });
    expect(r.decision).toBe("endorse");
    expect(r.label).toBe("Recommend approval, with warnings");
    expect(r.warnings).toEqual([
      "Credits: 1 paid day left; 2 days would be without pay",
      "Filed 3 days ahead (rule: 7)",
      "Staffing below 80% on Dec 7 (70%)",
    ]);
  });

  it("holidays in the range are named and not counted; weekends are not leave days", () => {
    const r = recommendFrom({ leave: leave({ start_date: "2026-12-24", end_date: "2026-12-28" }), remaining: 5, filedKey: "2026-11-23", holidays: ["2026-12-25"] });
    expect(r.reasons.some((x) => x.startsWith("Calendar: 1 holiday in the range (Dec 25)"))).toBe(true);
    expect(rangeDays("2026-12-24", "2026-12-28")).toEqual(["2026-12-24", "2026-12-25", "2026-12-28"]);
  });

  it("without pay uses no credits; a half day has its own filing window", () => {
    const r = recommendFrom({ leave: leave({ pay_status: "without_pay", half_day: "AM", end_date: "2026-12-07" }), remaining: 0, filedKey: "2026-12-06" });
    expect(r.warnings).toEqual([]);
    expect(r.reasons).toEqual(expect.arrayContaining(["Without pay: no credits used", "Half day: its own filing window"]));
  });
});
