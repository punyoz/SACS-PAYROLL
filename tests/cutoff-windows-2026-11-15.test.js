/**
 * 2026-11-15 check: the October 1-15 payslip counted attendance to October 14.
 *
 * Not an off-by-one: each payslip deducts attendance up to the day BEFORE its
 * generation day (a day still in progress cannot be judged), and that day
 * carries into the next payslip's window (src/lib/payroll/semi-monthly.js,
 * src/lib/payroll/schedule.js). These tests pin the rule with the live
 * schedule (1st half on the 15th, next working day; 2nd half on the month's
 * last day, previous working day): every calendar day falls in exactly one
 * payslip's window, the last day of a cutoff included, February too.
 */

import { describe, it, expect } from "vitest";
import { createPayslipSchedule } from "@/lib/payroll/schedule";
import { firstHalfWindow, secondHalfWindow, shiftMonth } from "@/lib/payroll/semi-monthly";

const LIVE = [{ id: "live", effective_from: "2026-10-16", first_half_day: 15, second_half_day: 31, window_days: 5, first_half_rule: "next_working_day", non_working_day_rule: "previous_working_day" }];
const schedule = createPayslipSchedule({ settings: LIVE, holidays: [] });
const windowsOf = (monthKey) => {
  const first = firstHalfWindow(monthKey, schedule.lockDayFor, schedule.forPeriod(`${monthKey}-01`).attendance_cutoff);
  return { first, second: secondHalfWindow(monthKey, schedule.lockDayFor, first) };
};
const days = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

describe("Cutoff attendance windows (live schedule)", () => {
  it("October 2026 as processed: Oct 1-14, then Oct 15-29 (Oct 15 counted on the 2nd half)", () => {
    const oct = windowsOf("2026-10");
    expect(oct.first.end_key).toBe("2026-10-14"); // generated Thu Oct 15
    expect(oct.second).toEqual({ start_key: "2026-10-15", end_key: "2026-10-29" }); // generated Fri Oct 30
  });

  it("November 1-15, 2026 includes November 15 (generated Mon Nov 16: Nov 15 is a Sunday)", () => {
    const nov = windowsOf("2026-11");
    expect(schedule.forPeriod("2026-11-01").generation_date).toBe("2026-11-16");
    expect(nov.first).toEqual({ start_key: "2026-10-30", end_key: "2026-11-15" });
  });

  it("the last day of a 2nd half (30th / 31st) and of February is counted, on its own payslip or the next", () => {
    const nov = windowsOf("2026-11");
    const dec = windowsOf("2026-12");
    expect(nov.second.end_key <= "2026-11-30" && dec.first.start_key <= "2026-11-30").toBe(true); // Nov 30 → Dec 1-15 when not counted in Nov 16-30
    const feb = windowsOf("2027-02");
    const mar = windowsOf("2027-03");
    expect(feb.second.end_key).toBe("2027-02-25"); // Feb 28, 2027 is a Sunday: generated Fri Feb 26
    expect(mar.first.start_key).toBe("2027-02-26"); // Feb 26-28 counted on March 1-15
  });

  it("every day from Oct 1, 2026 to Dec 31, 2027 is in exactly one window (none skipped, none twice)", () => {
    const seen = new Map();
    for (let m = "2026-10"; m <= "2027-12"; m = shiftMonth(m, 1)) {
      const w = windowsOf(m);
      for (const [label, win] of [[`${m} 1st`, w.first], [`${m} 2nd`, w.second]]) {
        for (const d of days(win.start_key, win.end_key)) {
          expect(seen.has(d), `${d} in ${seen.get(d)} and ${label}`).toBe(false);
          seen.set(d, label);
        }
      }
    }
    const missing = days("2026-10-01", windowsOf("2027-12").second.end_key).filter((d) => !seen.has(d));
    expect(missing).toEqual([]);
  });
});
