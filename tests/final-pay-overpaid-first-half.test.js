/**
 * Anjo Saraga's final pay (PS-202610-0012, separated 2026-10-21), investigated
 * 2026-11-15: every day 2026-10-01 – 10-21 absent, yet the October 1-15
 * payslip paid 603.45. The final pay then shows gross -553.16, net 0:
 *
 *   salary            0 paid days × 689.65 − 1st half paid 603.45 = -603.45
 *   13th month        (603.45 + 0.00) ÷ 12                         =  +50.29
 *   gross                                                          = -553.16
 *   net               max(0, gross)                                =    0.00
 *
 * Two problems in computeFinalPay (src/lib/payroll/final-pay.js):
 *   1. The 13th month counts the 1st half twice: basicEarnedYtd already holds
 *      the 1st half's basic, and the month's full `earned` is added again.
 *      Here the 1st half was taken back, yet 50.29 of 13th month is paid on it.
 *   2. An overpaid 1st half (negative salary line) is floored away in net pay:
 *      the 553.16 is neither recovered nor reported anywhere.
 *
 * The first block pins today's behaviour. The skipped block is the PROPOSED
 * fix for future final pays (open decision, not applied): Anjo's stored final
 * pay is not changed either way.
 */

import { describe, it, expect } from "vitest";
import { computeFinalPay } from "@/lib/payroll/final-pay";

const anjo = {
  monthlySalary: 15000,
  dailyRate: 689.65,
  separatedOn: "2026-10-21",
  months: [{
    month_key: "2026-10", window: { start_key: "2026-10-01", end_key: "2026-10-29" }, absent_days: 15,
    first_half_paid: 603.45, partial: { paid: 0, unpaid_holidays: [] },
  }],
  basicEarnedYtd: 603.45, // the October 1-15 payslip's basic
  thirteenthPaid: false,
  contributions: {},
  taxTable: [],
  loans: [],
};

describe("Final pay after an overpaid 1st half (Anjo, today's behaviour)", () => {
  it("reproduces the stored -553.16 gross and 0 net", () => {
    const r = computeFinalPay(anjo);
    expect(r.earnings.find((e) => e.kind === "salary").amount).toBe(-603.45);
    expect(r.thirteenth_month).toBe(50.29);
    expect(r.gross).toBe(-553.16);
    expect(r.net_pay).toBe(0);
  });

  it("double-counts the 1st half in the 13th month of an ordinary separation too", () => {
    // 10 paid days to the 21st (6,896.50 earned in October), 1st half paid 5,000.
    const r = computeFinalPay({ ...anjo, months: [{ ...anjo.months[0], first_half_paid: 5000, partial: { paid: 10, unpaid_holidays: [] } }], basicEarnedYtd: 5000 });
    expect(r.basic_earned).toBe(6896.5);
    expect(r.thirteenth_month).toBe(991.38); // (5,000 + 6,896.50) ÷ 12: the 5,000 counted twice
  });
});

describe.skip("PROPOSED for future final pays (open decision; not applied)", () => {
  it("13th month counts only what the final pay adds on top of the 1st half", () => {
    const r = computeFinalPay(anjo);
    expect(r.thirteenth_month).toBe(0); // (603.45 + (0 − 603.45)) ÷ 12
  });

  it("an overpaid 1st half is reported for HR to recover, not floored away", () => {
    const r = computeFinalPay(anjo);
    expect(r.net_pay).toBe(0);
    expect(r.overpayment).toBe(603.45);
  });

  it("an ordinary separation's 13th month counts the 1st half once", () => {
    const r = computeFinalPay({ ...anjo, months: [{ ...anjo.months[0], first_half_paid: 5000, partial: { paid: 10, unpaid_holidays: [] } }], basicEarnedYtd: 5000 });
    expect(r.thirteenth_month).toBe(574.71); // (5,000 + 1,896.50) ÷ 12
  });
});
