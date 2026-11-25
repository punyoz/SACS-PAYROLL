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

describe("one A4 page (2026-11-25 fix)", () => {
  const pages = (pdf) => (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  const leave = { label: "Vacation, sick, emergency (one pool)", year: 2026, as_of: "2026-11-30", allotment: 5, used: 1, used_by_type: { "Vacation Leave": 1 }, remaining: 4 };
  const taxBox = { rows: [{ label: "Monthly basic salary", amount: 30000, sign: "" }, { label: "Other earnings (overload, incentives, overtime, holiday pay)", amount: 1500, sign: "+" },
    { label: "Attendance deductions (whole month)", amount: 965.52, sign: "-" }, { label: "Non-taxable items left out", amount: 500, sign: "-" }, { label: "SSS, PhilHealth and Pag-IBIG", amount: 2450, sign: "-" }],
    taxable: 27584.48, tax: 1012.72, bracket: "₱20,833 to ₱33,332", formula: "₱0.00 + 15% × (₱27,584.48 − ₱20,833.00) = ₱1,012.72", reason: null };
  const ytd = { year: 2026, gross: 160000, taxable: 140000, tax: 5000, sss: 7500, philhealth: 3750, pagibig: 1000, basic: 150000, thirteenth_accrued: 12500, payslips: 10 };
  const details = (extra = {}) => ({
    payslip_no: "PS-1", pay_period: "November 16-30, 2026", status: "final", status_label: "Paid", employee: { name: "Test", id: "T-1", position: "Teacher", branch: "Main", type: "Teaching · Regular" },
    attendance_summary: { days_present: 10, days_absent: 1, half_days: 0, late_minutes: 0, undertime_minutes: 0, leave_days: 1 },
    // A typical 2nd half (like the stored ones this was found on): overtime, holiday pay, absences, lates, perfect attendance.
    earnings: { basic_salary: 15000, overtime: 450, holiday_pay: 900, gross_pay: 16850 },
    deductions: { sss: 1500, philhealth: 750, pagibig: 200, withholding_tax: 1012.72, absence_deduction: 965.52, late_days: 2, late_deduction: 120,
      total_deductions: 4548.24, leave_with_pay_days: 1 },
    incentives: { perfect_attendance_incentive: 500 }, leave_daily_rate: 1379.31,
    net_pay: 12071.76, tax_box: taxBox, ytd, leave_balance: leave, ...extra,
  });

  it("a 2nd half with the tax computation, the year to date and the leave balance is one page", async () => {
    const { buildPayslipPdf } = await import("@/lib/payroll/payslip-pdf");
    expect(pages(await buildPayslipPdf(details()))).toBe(1);
  });

  it("a dense 2nd half (an absence, a late, a cash advance and the boxes) is still one page (compact rows)", async () => {
    const { buildPayslipPdf } = await import("@/lib/payroll/payslip-pdf");
    const dense = details({ deductions: { ...details().deductions, cash_advance: 1500, half_days: 1, half_day_deduction: 689.66, undertime_minutes: 30, undertime_deduction: 57.47,
      total_deductions: 6795.37 } });
    expect(pages(await buildPayslipPdf(dense))).toBe(1);
  });

  it("a 1st half (year to date only) shows the leave balance as a box beside it, one page", async () => {
    const { buildPayslipPdf } = await import("@/lib/payroll/payslip-pdf");
    expect(pages(await buildPayslipPdf(details({ tax_box: null, pay_period: "November 1-15, 2026" })))).toBe(1);
  });
});
