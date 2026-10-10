/**
 * The school's payroll sheet (src/lib/payroll/school-sheet.js) and cash
 * advances (src/lib/payroll/cash-advance.js), checked against real rows of
 * Shepherd Angels Christian School of Antipolo's sheet for March 16-31, 2026:
 *
 *   Rate = monthly ÷ 2, Daily = Rate ÷ 12, Amount = Rate − Daily × days missed,
 *   OT Rate = Rate ÷ 96 × 1.25, Net = Total Amount − (CA + SSS + Pag-IBIG).
 *
 * The sheet prints whole pesos; these figures keep the centavos it rounds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  contributionsForHalf,
  monthlyContributionsFor,
  periodDaysFor,
  sheetFigures,
  sheetTotals,
  usesPerHalfRule,
  workingDaysIn,
} from "@/lib/payroll/school-sheet";
import {
  advanceBalance,
  appliesToPeriod,
  repaidByAdvance,
  scheduleCashAdvances,
  validateCashAdvanceInput,
} from "@/lib/payroll/cash-advance";
import { validateRateInput } from "@/lib/payroll/rates";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const FIXED = { contribution_method: 1, sss_fixed: 400, philhealth_fixed: 0, pagibig_fixed: 200 };

/** One sheet row from Rate, days missed, OT hours and deductions. */
function row({ rate, missed = 0, otHours = 0, ca = 0, sss = 400, pagibig = 200 }) {
  const daily = rate / 12;
  const hourly = daily / 8;
  return sheetFigures({
    basic: rate,
    daily,
    hourly,
    periodDays: 12,
    absenceDeduction: daily * missed,
    overtimeMinutes: otHours * 60,
    overtimePay: otHours * hourly * 1.25,
    overtimePremiumPct: 25,
    cashAdvance: ca,
    sss,
    pagibig,
  });
}

describe("sheet columns reproduce the school's rows", () => {
  it("Nate, Angelica T.: 10.5 days of 5,250", () => {
    expect(row({ rate: 5250, missed: 1.5 })).toMatchObject({
      days: 10.5, regular_hours: 84, amount: 4593.75, ot_rate: 68.36, total_deduction: 600, net_pay: 3993.75,
    });
  });

  it("Flores, Mary Grace K.: 11 days, cash advance 1,000", () => {
    expect(row({ rate: 5250, missed: 1, ca: 1000 })).toMatchObject({ days: 11, regular_hours: 88, amount: 4812.5, total_deduction: 1600, net_pay: 3212.5 });
  });

  it("Hubilla, Philip Jhay Mhar S.: 11.5 days", () => {
    expect(row({ rate: 5250, missed: 0.5 })).toMatchObject({ days: 11.5, regular_hours: 92, amount: 5031.25, net_pay: 4431.25 });
  });

  it("Conwi, John Ken H. (Pinugay): 11.5 days, 9 h overtime, no SSS / Pag-IBIG", () => {
    const conwi = row({ rate: 5000, missed: 0.5, otHours: 9, ca: 1000, sss: 0, pagibig: 0 });
    expect(conwi).toMatchObject({ days: 11.5, amount: 4791.67, ot_hours: 9, ot_rate: 65.1, ot_amount: 585.94, total_amount: 5377.61 });
    expect(conwi.net_pay).toBe(4377.61);
  });

  it("Salarda, Adrian Kien (Pinugay): 10 days of 6,000, 12 h overtime at 78.13", () => {
    expect(row({ rate: 6000, missed: 2, otHours: 12, sss: 400, pagibig: 0 })).toMatchObject({
      days: 10, amount: 5000, ot_rate: 78.13, ot_amount: 937.5, total_amount: 5937.5, net_pay: 5537.5,
    });
  });

  it("totals the Main branch exactly: 42,250 rate, 2,800 deductions, 39,450 net", () => {
    const main = [
      row({ rate: 6000 }),
      row({ rate: 6250, sss: 0 }),
      row({ rate: 6750 }),
      row({ rate: 4750, pagibig: 0 }),
      row({ rate: 11000 }),
      row({ rate: 7500, pagibig: 0 }),
    ];
    expect(sheetTotals(main)).toMatchObject({ rate: 42250, amount: 42250, sss: 2000, pagibig: 800, total_deduction: 2800, net_pay: 39450 });
  });

  it("totals the Pinugay branch: the OT column adds to 1,523.44 (the sheet shows 1,523)", () => {
    const pinugay = [
      row({ rate: 4750, ca: 1000, sss: 0, pagibig: 0 }),
      row({ rate: 5000, missed: 0.5, otHours: 9, ca: 1000, sss: 0, pagibig: 0 }),
      row({ rate: 6000, missed: 2, otHours: 12, sss: 400, pagibig: 0 }),
    ];
    expect(sheetTotals(pinugay)).toMatchObject({ rate: 15750, ot_hours: 21, ot_amount: 1523.44, cash_advance: 2000, total_deduction: 2400 });
  });
});

describe("periods and contributions", () => {
  it("has 12 days a half when the divisor is 24 a month, else the half's working days", () => {
    expect(periodDaysFor(24, 11)).toBe(12);
    expect(periodDaysFor(261, 11)).toBe(11);
    expect(workingDaysIn("2026-03-16", "2026-03-31")).toBe(12);
    expect(workingDaysIn("2026-10-16", "2026-10-31", new Set(["2026-10-30"]))).toBe(10);
  });

  it("uses the fixed amounts, then each employee's own (0 = exempt)", () => {
    expect(monthlyContributionsFor(10500, FIXED)).toMatchObject({ sss: 400, philhealth: 0, pagibig: 200, source: { sss: "fixed" } });
    expect(monthlyContributionsFor(10500, FIXED, { sss: 0 })).toMatchObject({ sss: 0, pagibig: 200, source: { sss: "employee", pagibig: "fixed" } });
    const legal = monthlyContributionsFor(10500, {
      contribution_method: 0, sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2,
      sss_msc_min: 5000, sss_msc_max: 35000, philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000,
    });
    expect(legal).toMatchObject({ sss: 525, philhealth: 262.5, pagibig: 200, source: { sss: "legal" } });
  });

  it("deducts them on the 1-15 payslip, the 16-end payslip, or half on each", () => {
    const month = { sss: 400, philhealth: 0, pagibig: 200 };
    expect(contributionsForHalf(month, "first", 2)).toEqual({ sss: 0, philhealth: 0, pagibig: 0 });
    expect(contributionsForHalf(month, "second", 2)).toEqual(month);
    expect(contributionsForHalf(month, "first", 1)).toEqual(month);
    expect(contributionsForHalf({ sss: 525.01, philhealth: 0, pagibig: 200 }, "first", 3)).toEqual({ sss: 262.51, philhealth: 0, pagibig: 100 });
    expect(contributionsForHalf({ sss: 525.01, philhealth: 0, pagibig: 200 }, "second", 3)).toEqual({ sss: 262.5, philhealth: 0, pagibig: 100 });
  });

  it("reads the per-half rule on the 1st of the month, from October 2026", () => {
    const configs = [{ id: "p", rate_type: "payroll_per_half", scope: "global", scope_ref: null, value: 1, effective_date: "2026-10-01", created_at: "x" }];
    expect(usesPerHalfRule(configs, "2026-10-16")).toBe(true);
    expect(usesPerHalfRule(configs, "2026-09-16")).toBe(false);
    expect(usesPerHalfRule([{ ...configs[0], effective_date: "2026-10-16" }], "2026-10-16")).toBe(false);
  });

  it("validates the new rate types", () => {
    const base = { scope: "global", effective_date: "2026-11-01" };
    expect(validateRateInput({ ...base, rate_type: "payroll_per_half", value: 1 })).toBeNull();
    expect(validateRateInput({ ...base, rate_type: "payroll_per_half", value: 2 })).toMatch(/1 \(on\)/);
    expect(validateRateInput({ ...base, rate_type: "contribution_half", value: 3 })).toBeNull();
    expect(validateRateInput({ ...base, rate_type: "contribution_half", value: 0 })).toMatch(/16-end/);
    expect(validateRateInput({ ...base, rate_type: "sss_fixed", value: 400 })).toBeNull();
  });
});

describe("cash advances", () => {
  const advance = {
    id: "ca-1", employee_id: "e", principal: 3000, installment_amount: 1000, deduct_on: "both",
    start_date: "2026-10-16", status: "active", date_granted: "2026-10-10", description: "Tuition",
  };
  const period = { start_key: "2026-10-16", label: "October 16-31, 2026" };

  it("deducts the installment: Berlon, Jane Aira S. nets 3,400", () => {
    const { total, lines } = scheduleCashAdvances({ advances: [advance], repaid: new Map(), period, available: 4400 });
    expect(total).toBe(1000);
    expect(lines[0]).toMatchObject({ amount: 1000, balance_before: 3000, balance_after: 2000 });
    expect(4400 - total).toBe(3400);
  });

  it("takes only the balance left, from Final payslips of other periods", () => {
    const entries = [
      { pay_period: "October 1-15, 2026", status: "paid", payroll: { cash_advances: [{ advance_id: "ca-1", amount: 2500 }] } },
      { pay_period: "October 16-31, 2026", status: "paid", payroll: { cash_advances: [{ advance_id: "ca-1", amount: 500 }] } },
      { pay_period: "November 1-15, 2026", status: "draft", payroll: { cash_advances: [{ advance_id: "ca-1", amount: 999 }] } },
    ];
    const repaid = repaidByAdvance(entries, { excludePeriod: period.label });
    expect(advanceBalance(advance, repaid)).toBe(500);
    expect(scheduleCashAdvances({ advances: [advance], repaid, period, available: 9000 }).total).toBe(500);
    expect(advanceBalance(advance, repaidByAdvance(entries))).toBe(0);
  });

  it("never pushes net pay below zero; the rest stays on the balance", () => {
    const { lines } = scheduleCashAdvances({ advances: [advance], repaid: new Map(), period, available: 300 });
    expect(lines[0]).toMatchObject({ due: 1000, amount: 300, balance_after: 2700 });
  });

  it("skips advances on hold, not started, or for the other half", () => {
    expect(appliesToPeriod({ ...advance, status: "on_hold" }, period)).toBe(false);
    expect(appliesToPeriod({ ...advance, start_date: "2026-11-01" }, period)).toBe(false);
    expect(appliesToPeriod({ ...advance, deduct_on: "first" }, period)).toBe(false);
    expect(appliesToPeriod({ ...advance, deduct_on: "second" }, period)).toBe(true);
  });

  it("validates a new advance", () => {
    const ok = { principal: 3000, installment_amount: 1000, deduct_on: "both", date_granted: "2026-10-10", start_date: "2026-10-16" };
    expect(validateCashAdvanceInput(ok)).toBeNull();
    expect(validateCashAdvanceInput({ ...ok, installment_amount: 4000 })).toMatch(/cannot be more/);
    expect(validateCashAdvanceInput({ ...ok, start_date: "2026-10-17" })).toMatch(/first pay period/);
  });
});

describe("accountant sidebar", () => {
  it("shows Incentives & Overload, Cash Advances and 13th Month Pay under Payroll", async () => {
    const { buildMenu, allowedPagesFor } = await import("@/lib/rbac/menu");
    const payroll = buildMenu("accountant").find((section) => section.section === "Payroll");
    // Loans and subsidy-adjustment Approvals (20261009010000) sit after
    // Payslips; Cash Advances stays as history.
    expect(payroll.items.map((item) => item.page)).toEqual([
      "ac-process", "ac-records", "ac-payslips", "ac-loans", "ac-approvals", "ac-incentives", "ac-cash-advances", "ac-13th",
    ]);
    expect(allowedPagesFor("accountant")).toEqual(expect.arrayContaining(["ac-cash-advances", "ac-incentives", "ac-13th"]));
    expect(allowedPagesFor("hr")).not.toContain("ac-cash-advances");
  });
});

/* ── Through the payroll API ────────────────────────────────────────────── */

const BRANCH = "b-main";
const NATE = "u-nate";
const BERLON = "u-berlon";
const SECOND = "October 16-31, 2026";
const FIRST = "October 1-15, 2026";

const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null,
  value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

const log = (id, employeeId, date, fields = {}) => ({
  id, employee_id: employeeId, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`,
  created_at: `${date}T00:00:00Z`, status: "On Time", late_minutes: 0, undertime_minutes: 0,
  is_half_day: false, is_early_bird: false, archived_duplicate: false, ...fields,
});

let GET;
let POST;
let PATCH;
let createSessionToken;
let SESSION_COOKIE;

function request(method, body, query = "") {
  const token = createSessionToken({
    user_id: "u-acct", role: "accountant", branch_id: BRANCH, email: "acct@sacs.test",
    full_name: "Ana Accountant", session_id: "s-1",
  });
  return new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// BIR monthly withholding table (20261003010000_semi_monthly_payroll.sql).
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];

const firstHalfPaid = (employeeId, rate) => ({
  id: `first-${employeeId}`,
  employee_id: employeeId,
  employee_name: employeeId,
  pay_period: FIRST,
  status: "paid",
  payslip_no: `PS-202610-${employeeId}`,
  payroll: { basic_salary: rate, basic_earned: rate, totals: { gross_pay: rate, total_deductions: 0, total_incentives: 0, net_pay: rate } },
});

/*
 * The school's two payslips: 1-15 pays the full Rate with nothing deducted;
 * 16-end deducts every deduction of the month (days missed, SSS ₱400,
 * Pag-IBIG ₱200, cash advances, tax).
 */
describe("the school's payroll through the API (1-15 full, 16-end deducts everything)", () => {
  afterEach(() => { vi.useRealTimers(); });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-school-sheet";
    resetDb();
    users.push(
      { id: NATE, email: "nate@sacs.test", user_metadata: { role: "employee", full_name: "Angelica Nate", employee_id: "SACS-001", basic_salary: 10500, branch_id: BRANCH } },
      { id: BERLON, email: "berlon@sacs.test", user_metadata: { role: "employee", full_name: "Jane Aira Berlon", employee_id: "SACS-002", basic_salary: 10000, branch_id: BRANCH } },
    );
    table("branches").push({ id: BRANCH, name: "Main" });
    table("profiles").push(
      { id: "u-acct", branch_id: BRANCH },
      { id: NATE, full_name: "Angelica Nate", first_name: "Angelica", middle_name: "Torres", last_name: "Nate", email: "nate@sacs.test", branch_id: BRANCH, role: "employee" },
      { id: BERLON, full_name: "Jane Aira Berlon", first_name: "Jane Aira", middle_name: "Santos", last_name: "Berlon", email: "berlon@sacs.test", branch_id: BRANCH, role: "employee" },
    );
    // The values 20261006010000_school_payroll_sheet.sql seeds.
    table("payroll_rate_configs").push(
      rate("hourly", 68.75), rate("daily", 550), rate("half_day_pct", 50), rate("absent_pct", 100),
      rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0), rate("perfect_attendance_bonus", 0),
      ...Object.entries({
        overtime_premium_pct: 25, working_days_per_year: 24, late_days_per_absent: 0,
        payroll_per_half: 0, contribution_method: 1, contribution_half: 2, sss_fixed: 400, philhealth_fixed: 0, pagibig_fixed: 200,
        attendance_lock_day: 15, carry_after_lock: 1,
      }).map(([type, value]) => rate(type, value, "2026-10-01")),
    );
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
      id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
    })));
    // Nate, read during 1-15: absent Oct 5, half day Oct 6 → 10.5 of 12
    // days, deducted on the October 16-31 payslip (lock day 15).
    table("attendance_logs").push(
      log("n1", NATE, "2026-10-02"),
      log("n2", NATE, "2026-10-05", { status: "Absent", time_in: null, time_out: null }),
      log("n3", NATE, "2026-10-06", { status: "Half Day", is_half_day: true }),
      log("b1", BERLON, "2026-10-02"),
    );
    table("payroll_cash_advances").push({
      id: "ca-berlon", employee_id: BERLON, branch_id: BRANCH, date_granted: "2026-10-10", principal: 3000,
      installment_amount: 1000, deduct_on: "second", start_date: "2026-10-16", status: "active", description: "Cash advance", created_at: "2026-10-10T00:00:00Z",
    });

    ({ GET, POST, PATCH } = await import("@/app/api/accountant/payroll/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("1-15: the full Rate, no deductions, no cash advance", async () => {
    vi.setSystemTime(new Date("2026-10-17T10:00:00+08:00"));
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(FIRST)}`))).json();
    expect(body.semi_monthly).toMatchObject({ half: "first" });
    const nate = body.attendance_rows.find((r) => r.employee_id === NATE);
    expect(nate.defaults).toMatchObject({ semi_monthly: "first", basic_salary: 5250, sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0 });
    const berlon = body.attendance_rows.find((r) => r.employee_id === BERLON);
    expect(berlon.defaults.cash_advance || 0).toBe(0);

    const response = await POST(request("POST", { action: "submit", pay_period: FIRST, employee_id: NATE, basic_salary: 5250 }));
    expect(response.status).toBe(200);
    const entry = table("payroll_entries").find((e) => e.employee_id === NATE && e.pay_period === FIRST);
    expect(entry.payroll.totals).toMatchObject({ gross_pay: 5250, total_deductions: 0, net_pay: 5250 });
    expect(entry.payroll.sheet).toMatchObject({ days: 12, regular_hours: 96, rate: 5250, amount: 5250, total_deduction: 0, net_pay: 5250 });
  });

  it("16-end: GET pre-fills the month's fixed contributions, days missed and the cash advance", async () => {
    table("payroll_entries").push(firstHalfPaid(NATE, 5250), firstHalfPaid(BERLON, 5000));
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.semi_monthly).toMatchObject({ half: "second", window: { start_key: "2026-10-01", end_key: "2026-10-15" } });
    expect(body.payroll_ready).toBe(true);
    const nate = body.attendance_rows.find((r) => r.employee_id === NATE);
    expect(nate.rates.daily).toBe(437.5);
    expect(nate.defaults).toMatchObject({
      semi_monthly: "second", basic_salary: 10500, sss: 400, philhealth: 0, pagibig: 200, withholding_tax: 0, first_half_paid: 5250, cash_advance: 0,
      contribution_source: { sss: "fixed", philhealth: "fixed", pagibig: "fixed" },
    });
    expect(nate.defaults.monthly).toMatchObject({ second_half_net: 3993.75 });
    expect(nate.defaults.sheet).toMatchObject({ rate: 5250, days: 10.5, regular_hours: 84, amount: 4593.75, total_deduction: 600, net_pay: 3993.75 });
    const berlon = body.attendance_rows.find((r) => r.employee_id === BERLON);
    expect(berlon.defaults).toMatchObject({ cash_advance: 1000 });
    expect(berlon.defaults.monthly).toMatchObject({ second_half_net: 3400 });
  });

  it("16-end: processes the sheet's net pay, writes the cash advance line, and the sheet view adds up", async () => {
    table("payroll_entries").push(firstHalfPaid(NATE, 5250), firstHalfPaid(BERLON, 5000));
    const response = await POST(request("POST", {
      action: "batch_submit",
      pay_period: SECOND,
      entries: [
        { employee_id: NATE, basic_salary: 10500, deductions: { sss: 400, philhealth: 0, pagibig: 200, withholding_tax: 0 } },
        { employee_id: BERLON, basic_salary: 10000, deductions: { sss: 400, philhealth: 0, pagibig: 200, withholding_tax: 0 } },
      ],
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toHaveLength(2);

    expect(table("payroll_records").find((r) => r.employee_id === NATE).net_pay).toBe(3993.75);
    expect(table("payroll_records").find((r) => r.employee_id === BERLON).net_pay).toBe(3400);
    expect(table("payroll_deductions").find((l) => l.employee_id === BERLON && l.type === "cash_advance")).toMatchObject({ amount: 1000 });
    expect(table("payroll_deductions").filter((l) => l.employee_id === BERLON && l.type === "sss")).toEqual([expect.objectContaining({ amount: 400, quantity: null })]);
    const entry = table("payroll_entries").find((e) => e.employee_id === BERLON && e.pay_period === SECOND);
    expect(entry.payroll.cash_advances).toEqual([expect.objectContaining({ advance_id: "ca-berlon", amount: 1000, balance_after: 2000 })]);

    const sheet = await (await GET(request("GET", null, `?view=payroll_sheet&period=${encodeURIComponent(SECOND)}`))).json();
    expect(sheet.attendance_window).toEqual({ start_key: "2026-10-01", end_key: "2026-10-15" });
    expect(sheet.branches).toHaveLength(1);
    expect(sheet.branches[0].branch_name).toBe("Main");
    expect(sheet.branches[0].rows.map((r) => r.name)).toEqual(["BERLON, JANE AIRA S.", "NATE, ANGELICA T."]);
    expect(sheet.branches[0].totals).toMatchObject({ rate: 10250, cash_advance: 1000, sss: 800, pagibig: 400, total_deduction: 2200, net_pay: 7393.75 });

    const advances = await (await GET(request("GET", null, "?view=cash_advances"))).json();
    expect(advances.advances[0]).toMatchObject({ repaid: 1000, balance: 2000, payments: [{ pay_period: SECOND, amount: 1000 }] });
  });

  it("deducts absences and leave without pay after the 15th on next month's 16-end payslip", async () => {
    table("payroll_entries").push(firstHalfPaid(NATE, 5250));
    table("attendance_logs").push(log("n4", NATE, "2026-10-19", { status: "Absent", time_in: null, time_out: null }));
    table("leave_requests").push({
      id: "lv-1", employee_id: NATE, status: "approved", pay_status: "without_pay",
      start_date: "2026-10-21", end_date: "2026-10-21", submitted_at: "2026-10-20T00:00:00Z",
    });
    let body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.attendance_rows.find((r) => r.employee_id === NATE).defaults.sheet).toMatchObject({ days: 10.5, net_pay: 3993.75 });

    // November 16-30 reads October 16 - November 15: the Oct 19 absence and
    // the Oct 21 leave without pay → 10 of 12 days, 5,250 − 2 × 437.50.
    vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
    body = await (await GET(request("GET", null, `?period=${encodeURIComponent("November 16-30, 2026")}`))).json();
    expect(body.semi_monthly).toMatchObject({ half: "second", window: { start_key: "2026-10-16", end_key: "2026-11-15" } });
    expect(body.attendance_rows.find((r) => r.employee_id === NATE).defaults.sheet).toMatchObject({ days: 10, amount: 4375 });
  });

  it("deducts leave without pay taken during 1-15", async () => {
    table("payroll_entries").push(firstHalfPaid(BERLON, 5000));
    table("leave_requests").push({
      id: "lv-2", employee_id: BERLON, status: "approved", pay_status: "without_pay",
      start_date: "2026-10-07", end_date: "2026-10-07", submitted_at: "2026-10-01T00:00:00Z",
    });
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    const berlon = body.attendance_rows.find((r) => r.employee_id === BERLON);
    // Daily 10,000 ÷ 24 = 416.67; 5,000 − 416.67 − 600 − 1,000 cash advance.
    expect(berlon.defaults.sheet).toMatchObject({ days: 11, amount: 4583.33, net_pay: 2983.33 });
  });

  it("an employee's own amounts win: SSS 0 makes them exempt", async () => {
    table("payroll_entries").push(firstHalfPaid(NATE, 5250));
    table("payroll_contribution_amounts").push({ id: "c1", employee_id: NATE, effective_date: "2026-10-01", sss: 0, philhealth: null, pagibig: null, created_at: "2026-10-01T00:00:00Z" });
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    const nate = body.attendance_rows.find((r) => r.employee_id === NATE);
    expect(nate.defaults).toMatchObject({ sss: 0, pagibig: 200, contribution_source: { sss: "employee", pagibig: "fixed" } });
    expect(nate.defaults.monthly).toMatchObject({ second_half_net: 4393.75 });
  });

  it("adds an advance and puts it on hold so it is skipped", async () => {
    const added = await POST(request("POST", {
      action: "add_cash_advance", employee_id: NATE, principal: 500, installment_amount: 500,
      deduct_on: "second", date_granted: "2026-10-20", start_date: "2026-10-16", description: "Emergency",
    }));
    expect(added.status).toBe(200);
    const id = table("payroll_cash_advances").find((r) => r.employee_id === NATE).id;
    let body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.attendance_rows.find((r) => r.employee_id === NATE).defaults.cash_advance).toBe(500);

    const held = await PATCH(request("PATCH", { action: "set_cash_advance_status", advance_id: id, status: "on_hold" }));
    expect(held.status).toBe(200);
    body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.attendance_rows.find((r) => r.employee_id === NATE).defaults.cash_advance).toBe(0);
  });

  it("refuses an advance starting on a payslip that is already Final", async () => {
    table("payroll_entries").push({ id: "e1", employee_id: NATE, pay_period: SECOND, status: "paid", payroll: {} });
    const response = await POST(request("POST", {
      action: "add_cash_advance", employee_id: NATE, principal: 500, installment_amount: 500,
      deduct_on: "second", date_granted: "2026-10-20", start_date: "2026-10-16",
    }));
    expect(response.status).toBe(409);
  });

  it("still offers each half on its own attendance when that switch is turned on", async () => {
    table("payroll_rate_configs").find((r) => r.rate_type === "payroll_per_half").value = 1;
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(FIRST)}`))).json();
    expect(body.semi_monthly).toBeNull();
    expect(body.per_half).toMatchObject({ half: "first" });
    const nate = body.attendance_rows.find((r) => r.employee_id === NATE);
    expect(nate.defaults).toMatchObject({ basic_salary: 5250, sss: 0, pagibig: 0, per_half: "first" });
    expect(nate.defaults.sheet).toMatchObject({ amount: 4593.75, net_pay: 4593.75 });
  });
});
