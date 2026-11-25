/**
 * Paid leave on the payslip (2026-11-25): an Earnings line "Paid leave (N days)" with its peso amount
 * (days × the payslip's own daily rate) shown as part of the Basic pay, never added to the gross again;
 * and a Leave Balance box (credits for the year, used to date, remaining), for information only.
 * Display only: no stored payslip, computation or credit changes.
 */
import { describe, expect, it } from "vitest";
import { leaveBalanceBox, paidLeaveDailyRate, paidLeaveRow, payslipTables, payslipTotalsCheck } from "@/lib/payroll/payslip-tables";
import { balanceOnDate, payslipDateKey } from "@/lib/payroll/payslip-leave";

// A payslip's flat fields (buildPayslipDetails without line groups): basic 11,000, no deductions.
const classic = (fields = {}) => ({
  earnings: { basic_salary: 11000, overtime: 0, holiday_pay: 0, gross_pay: 11000 },
  deductions: { sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, total_deductions: 0, leave_with_pay_days: 0 },
  incentives: {},
  ...fields,
});
const withLeave = (days, extra = {}) => classic({
  deductions: { sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, total_deductions: 0, leave_with_pay_days: days, ...extra },
  leave_daily_rate: 1011.49,
});
const leaveLine = (t) => t.earnings.find((r) => r.key === "leave_with_pay");

describe("Paid leave line in the Earnings", () => {
  it("2 paid leave days: 'Paid leave (2 days)' with days × daily rate, inside Basic pay; gross, deductions and net unchanged", () => {
    const before = payslipTables(classic());
    const after = payslipTables(withLeave(2));
    const line = leaveLine(after);
    expect(line.label).toBe("Paid leave (2 days)");
    expect(line.text).toBe("₱2,022.98 in Basic pay");
    expect(line.formula).toBe("2 × ₱1,011.49 daily rate");
    expect(line.amount).toBe(0);   // a text row: never summed
    expect(after.gross).toBe(before.gross);
    expect(after.total_deductions).toBe(before.total_deductions);
    expect(payslipTotalsCheck(after, 11000)).toEqual([]);
  });

  it("no paid leave: no line at all (no ₱0 line)", () => {
    expect(leaveLine(payslipTables(classic()))).toBeUndefined();
    expect(leaveLine(payslipTables(withLeave(0)))).toBeUndefined();
  });

  it("a half day with pay counts 0.5 day", () => {
    const line = leaveLine(payslipTables(withLeave(0.5)));
    expect(line.label).toBe("Paid leave (0.5 days)");
    expect(line.text).toBe("₱505.75 in Basic pay");
  });

  it("the leave types show when the payslip stored them", () => {
    const line = leaveLine(payslipTables(withLeave(2, { leave_with_pay_by_type: { "Vacation Leave": 1, "Sick Leave": 1 } })));
    expect(line.label).toBe("Paid leave (2 days: Vacation 1, Sick 1)");
  });

  it("an older payslip without a stored daily rate shows the days only, no guessed amount", () => {
    const line = leaveLine(payslipTables({ ...withLeave(1), leave_daily_rate: null }));
    expect(line.text).toBe("In Basic pay, no deduction");
    expect(line.leave_amount).toBeUndefined();
  });

  it("the daily rate is the payslip's own (audit.rates.daily), else null", () => {
    expect(paidLeaveDailyRate({ audit: { rates: { daily: { value: 1103.45 } } } })).toBe(1103.45);
    expect(paidLeaveDailyRate({})).toBeNull();
    expect(paidLeaveRow(1, null, 1103.45).text).toBe("₱1,103.45 in Basic pay");
  });
});

describe("Leave Balance box", () => {
  const pool = { pool: { allotment: 5 } };
  const reqs = [
    { leave_type: "Sick Leave", start_date: "2026-10-06", end_date: "2026-10-06", status: "approved", pay_status: "with_pay" },
    { leave_type: "Vacation Leave", start_date: "2026-10-20", end_date: "2026-10-21", status: "approved", pay_status: "with_pay" },
    { leave_type: "Emergency Leave", start_date: "2026-11-03", end_date: "2026-11-03", status: "approved", pay_status: "with_pay", half_day: true },
    { leave_type: "Vacation Leave", start_date: "2026-11-10", end_date: "2026-11-10", status: "approved", pay_status: "without_pay" },
  ];

  it("each payslip date: used to date (this period included) and remaining; a 2nd half shows the year to date", () => {
    expect(balanceOnDate(pool, reqs, payslipDateKey("October 1-15, 2026"))).toMatchObject({ allotment: 5, used: 1, remaining: 4, as_of: "2026-10-15" });
    expect(balanceOnDate(pool, reqs, payslipDateKey("October 16-31, 2026"))).toMatchObject({ used: 3, remaining: 2 });
    expect(balanceOnDate(pool, reqs, payslipDateKey("November 1-15, 2026"))).toMatchObject({ used: 3.5, remaining: 1.5, without_pay_used: 1 });
  });

  it("a leave that runs past the payslip date counts only its days up to that date", () => {
    expect(balanceOnDate(pool, [{ ...reqs[1], start_date: "2026-10-14", end_date: "2026-10-17" }], "2026-10-15").used).toBe(2);
  });

  it("at the year's end it equals My Leave (every approved paid day of the year); never below 0", () => {
    expect(balanceOnDate(pool, reqs, "2026-12-31")).toMatchObject({ used: 3.5, remaining: 1.5 });
    expect(balanceOnDate({ pool: { allotment: 1 } }, reqs, "2026-12-31").remaining).toBe(0);
  });

  it("the box: for information only; null when the credits could not be read", () => {
    const box = leaveBalanceBox(balanceOnDate(pool, reqs, "2026-10-31"));
    expect(box.note).toBe("For information only, not part of your pay.");
    expect(box.rows.map((r) => [r.label, r.value])).toEqual([
      ["Leave type", "Vacation, sick, emergency (one pool)"],
      ["Credits for 2026", "5 days"],
      ["Used to date (Oct 31): Vacation 2, Sick 1", "3 days"],
      ["Remaining", "2 days"],
    ]);
    expect(leaveBalanceBox(null)).toBeNull();
    expect(payslipTables({ ...classic(), leave_balance: null }).leave_balance).toBeNull();
  });

  it("the box never changes the pay", () => {
    const t = payslipTables({ ...withLeave(1), leave_balance: balanceOnDate(pool, reqs, "2026-10-31") });
    expect(t.gross).toBe(11000);
    expect(payslipTotalsCheck(t, 11000)).toEqual([]);
  });
});
