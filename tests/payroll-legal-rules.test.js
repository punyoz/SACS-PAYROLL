/**
 * Payroll from October 1, 2026 (src/lib/payroll/statutory.js):
 *
 *   - SSS / PhilHealth / Pag-IBIG from the legal base of the MONTHLY salary,
 *     half per semi-monthly payslip;
 *   - BIR withholding tax on the period's taxable compensation;
 *   - daily rate = monthly salary × 12 ÷ 261, hourly = daily ÷ 8;
 *   - overtime paid only for APPROVED minutes, at hourly × 125%;
 *   - work on a regular holiday + 100% of the daily rate;
 *   - every payslip committed all-or-nothing (public.payroll_commit_entries).
 *
 * From the same date payroll is semi-monthly (src/lib/payroll/semi-monthly.js):
 * the 1st half pays half the salary with nothing deducted, and the 2nd half
 * settles the month -- whole-month contributions and the MONTHLY tax table --
 * less what the 1st half paid.
 *
 * Earlier periods keep the old flat-% rules; tests/payroll-attendance-route.test.js
 * pins those.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users, rpc } from "./helpers/fake-supabase.js";
import {
  SEMI_MONTHLY_TAX_TABLE,
  monthlyContributions,
  periodContributions,
  sssMonthlySalaryCredit,
  usesLegalRules,
  withholdingTax,
} from "@/lib/payroll/statutory";
import { resolveRates, DEFAULT_RATES } from "@/lib/payroll/rates";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const LEGAL = {
  sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2,
  sss_msc_min: 5000, sss_msc_max: 35000, philhealth_floor: 10000, philhealth_ceiling: 100000,
  pagibig_max_salary: 10000,
};

/* ── Contribution and tax tables ────────────────────────────────────────── */

describe("statutory tables", () => {
  it("rounds the salary to the SSS bracket and keeps it within the credit range", () => {
    expect(sssMonthlySalaryCredit(5249.99, LEGAL)).toBe(5000);
    expect(sssMonthlySalaryCredit(5250, LEGAL)).toBe(5500);
    expect(sssMonthlySalaryCredit(20000, LEGAL)).toBe(20000);
    expect(sssMonthlySalaryCredit(4000, LEGAL)).toBe(5000);
    expect(sssMonthlySalaryCredit(80000, LEGAL)).toBe(35000);
  });

  it("computes each employee share on its legal base", () => {
    expect(monthlyContributions(20000, LEGAL)).toMatchObject({ sss: 1000, philhealth: 500, pagibig: 200 });
    // PhilHealth floor, Pag-IBIG below the cap.
    expect(monthlyContributions(8000, LEGAL)).toMatchObject({ sss: 400, philhealth: 250, pagibig: 160 });
    // SSS and Pag-IBIG caps; PhilHealth ceiling.
    expect(monthlyContributions(150000, LEGAL)).toMatchObject({ sss: 1750, philhealth: 2500, pagibig: 200 });
    // Half of each on a semi-monthly payslip.
    expect(periodContributions(20000, LEGAL)).toMatchObject({ sss: 500, philhealth: 250, pagibig: 100 });
    expect(monthlyContributions(0, LEGAL)).toMatchObject({ sss: 0, philhealth: 0, pagibig: 0 });
  });

  it("applies the BIR semi-monthly withholding table", () => {
    expect(withholdingTax(10417)).toBe(0);
    expect(withholdingTax(10418)).toBe(0.15);
    expect(withholdingTax(16667)).toBe(937.5);
    expect(withholdingTax(27622.5)).toBe(3128.6);
    expect(withholdingTax(33333)).toBe(4270.7);
    expect(withholdingTax(100000)).toBe(21770.8);
    expect(withholdingTax(-5)).toBe(0);
    expect(SEMI_MONTHLY_TAX_TABLE.map((b) => b.over)).toEqual([0, 10417, 16667, 33333, 83333, 333333]);
  });

  it("takes effect for periods starting on October 1, 2026", () => {
    expect(usesLegalRules("2026-09-16")).toBe(false);
    expect(usesLegalRules("2026-10-01")).toBe(true);
  });
});

/* ── Daily rate from salary ─────────────────────────────────────────────── */

describe("daily rate", () => {
  const configs = [
    { id: "d", rate_type: "daily", scope: "global", scope_ref: null, value: 550, effective_date: "2026-01-01", created_at: "2026-01-01" },
    { id: "wd", rate_type: "working_days_per_year", scope: "global", scope_ref: null, value: 261, effective_date: "2026-10-01", created_at: "2026-10-01" },
  ];

  it("is the employee's salary × 12 ÷ working days from October 1, 2026", () => {
    const rates = resolveRates(configs, { employeeId: "e1", monthlySalary: 52200 }, "2026-10-01");
    expect(rates.daily).toMatchObject({ value: 2400, source: "salary" });
    expect(rates.hourly).toMatchObject({ value: 300, source: "derived" });
  });

  it("keeps the configured rate before then, and for an employee with no salary", () => {
    expect(resolveRates(configs, { employeeId: "e1", monthlySalary: 52200 }, "2026-09-16").daily.value).toBe(550);
    expect(resolveRates(configs, { employeeId: "e1", monthlySalary: 0 }, "2026-10-01").daily.value).toBe(550);
  });

  it("yields to a daily rate set for that one employee", () => {
    const own = [...configs, { id: "e", rate_type: "daily", scope: "employee", scope_ref: "e1", value: 1000, effective_date: "2026-01-01", created_at: "2026-01-01" }];
    const rates = resolveRates(own, { employeeId: "e1", monthlySalary: 52200 }, "2026-10-01");
    expect(rates.daily.value).toBe(1000);
    expect(rates.hourly.value).toBe(125);
  });
});

/* ── Overtime and holiday earnings ──────────────────────────────────────── */

describe("computeAttendancePay earnings", () => {
  const rates = { ...DEFAULT_RATES, hourly: 300, daily: 2400 };
  const base = { status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false };

  it("pays only approved overtime minutes, at hourly × (1 + premium)", () => {
    const pay = computeAttendancePay({
      logs: [
        { id: "a", log_date: "2026-10-01", time_in: "2026-10-01T00:00:00Z", time_out: "2026-10-01T12:00:00Z", ...base },
        { id: "b", log_date: "2026-10-02", time_in: "2026-10-02T00:00:00Z", time_out: "2026-10-02T12:00:00Z", ...base },
      ],
      rates,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-15",
      overtime: new Map([["a", 120]]),
    });
    expect(pay.amounts.overtime).toBe(750);
    expect(pay.counts.overtime_minutes).toBe(120);
    expect(pay.earnings).toEqual([expect.objectContaining({ type: "overtime", source_log_id: "a", amount: 750 })]);
  });

  it("prorates holiday pay by hours worked, and pays nothing without a time out", () => {
    const pay = computeAttendancePay({
      logs: [
        { id: "h1", log_date: "2026-10-05", time_in: "2026-10-05T00:00:00Z", time_out: "2026-10-05T04:00:00Z", ...base },
        { id: "h2", log_date: "2026-10-06", time_in: "2026-10-06T00:00:00Z", time_out: null, ...base },
      ],
      rates,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-15",
      holidays: new Map([["2026-10-05", "holiday"], ["2026-10-06", "special"]]),
    });
    // 4 of 8 hours on a regular holiday: half of 100% × 2,400.
    expect(pay.amounts.holiday_premium).toBe(1200);
    expect(pay.earnings).toHaveLength(1);
  });
});

/* ── The payroll route, October 1-15, 2026 ──────────────────────────────── */

const BRANCH = "branch-a";
const EMP = "u-emp";
const PERIOD = "October 1-15, 2026";

const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`,
  rate_type: rateType,
  scope: "global",
  scope_ref: null,
  value,
  effective_date: effectiveDate,
  created_at: `${effectiveDate}T00:00:00Z`,
});

const log = (id, date, fields = {}) => ({
  id,
  employee_id: EMP,
  log_date: date,
  time_in: `${date}T00:00:00Z`,
  time_out: `${date}T09:00:00Z`,
  created_at: `${date}T00:00:00Z`,
  status: "On Time",
  late_minutes: 0,
  undertime_minutes: 0,
  is_half_day: false,
  is_early_bird: false,
  archived_duplicate: false,
  ...fields,
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

// Salary 52,200: daily 2,400, hourly 300, half-month basic 26,100.
// Semi-monthly payroll (src/lib/payroll/semi-monthly.js): October 1-15 pays
// 26,100 with nothing deducted; October 16-31 settles the month:
//   SSS: credit capped at 35,000 × 5% = 1,750; PhilHealth 52,200 × 2.5% =
//   1,305; Pag-IBIG 10,000 × 2% = 200 → 3,255. Overtime: 120 approved min ×
//   300 × 125% = 750. Holiday (Oct 5, 9 h): 100% × 2,400 = 2,400.
//   Monthly gross 52,200 + 750 + 2,400 = 55,350; taxable 52,095 → BIR monthly
//   1,875 + 20% × (52,095 − 33,333) = 5,627.40. Monthly net 46,467.60, less
//   26,100 paid in the 1st half = 20,367.60.
const EXPECTED = {
  sss: 1750, philhealth: 1305, pagibig: 200, tax: 5627.4, overtime: 750, holiday: 2400,
  monthlyGross: 55350, monthlyNet: 46467.6, firstHalf: 26100, secondHalf: 20367.6,
};
const SECOND = "October 16-31, 2026";

// BIR monthly withholding table (20261003010000_semi_monthly_payroll.sql).
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const taxRows = (rows, versionId = "bir", effectiveDate = "2023-01-01", createdAt = "2023-01-01T00:00:00Z") => rows.map(([over, base, pct]) => ({
  id: `${versionId}-${over}`, version_id: versionId, effective_date: effectiveDate,
  bracket_over: over, base_tax: base, rate_pct: pct, created_at: createdAt,
}));

const firstHalfPaid = (net = 26100, gross = net) => ({
  id: "entry-oct-1",
  employee_id: EMP,
  employee_name: "Emma Employee",
  pay_period: PERIOD,
  status: "paid",
  payslip_no: "PS-202610-0001",
  payroll: { basic_salary: gross, basic_earned: gross, totals: { gross_pay: gross, total_deductions: gross - net, total_incentives: 0, net_pay: net } },
});

// Processing writes Final payslips, accepted only after the period ends and up
// to its pay date (src/lib/payroll/generation-window.js): Oct 17 is inside
// October 1-15's window.
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-legal-rules";
  resetDb();
  users.push({
    id: EMP,
    email: "emp@sacs.test",
    user_metadata: { role: "employee", full_name: "Emma Employee", employee_id: "SACS-001", basic_salary: 52200, branch_id: BRANCH },
  });
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH },
    { id: EMP, full_name: "Emma Employee", email: "emp@sacs.test", branch_id: BRANCH, role: "employee", basic_salary: 52200, employee_id: "SACS-001", rfid_uid: null, archived: false },
  );
  table("payroll_rate_configs").push(
    rate("hourly", 68.75), rate("daily", 550), rate("half_day_pct", 50), rate("absent_pct", 100),
    rate("late_days_per_absent", 3), rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0),
    rate("perfect_attendance_bonus", 0), rate("sss_pct", 2), rate("philhealth_pct", 2), rate("pagibig_pct", 2),
    ...Object.entries({ ...LEGAL, overtime_premium_pct: 25, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30, working_days_per_year: 261 })
      .map(([type, value]) => rate(type, value, "2026-10-01")),
  );
  table("payroll_tax_brackets").push(...taxRows(BIR_MONTHLY));
  table("attendance_holidays").push({ holiday_date: "2026-10-05", name: "Test Holiday", type: "holiday" });
  table("attendance_logs").push(
    log("o1", "2026-10-01", { time_out: "2026-10-01T12:00:00Z" }),
    log("h1", "2026-10-05"),
  );
  table("attendance_overtime_approvals").push({ log_id: "o1", employee_id: EMP, log_date: "2026-10-01", overtime_minutes: 180, approved_minutes: 120, status: "approved" });

  ({ GET, POST, PATCH } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("October 1-15, 2026 (1st half)", () => {
  it("GET pre-fills the full semi-monthly salary with nothing deducted", async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(PERIOD)}`))).json();
    expect(body.legal_rules).toBe(true);
    expect(body.semi_monthly).toMatchObject({ half: "first", month_label: "October 2026" });
    expect(body.tax_table).toEqual([]);
    const row = body.attendance_rows.find((r) => r.employee_id === EMP);
    expect(row.defaults).toMatchObject({
      semi_monthly: "first", basic_salary: 26100, sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, overtime: 0, holiday_pay: 0,
    });
  });

  it("processes 26,100 with no deductions, contributions or tax", async () => {
    const response = await POST(request("POST", {
      action: "batch_submit",
      pay_period: PERIOD,
      entries: [{ employee_id: EMP, basic_salary: 26100, deductions: { sss: 999, withholding_tax: 999 } }],
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toHaveLength(1);
    expect(body.processed[0].payslip_no).toMatch(/^PS-\d{6}-0001$/);

    const record = table("payroll_records").find((r) => r.employee_id === EMP);
    expect(record).toMatchObject({ gross_pay: 26100, total_deductions: 0, net_pay: 26100 });
    const entry = table("payroll_entries").find((e) => e.employee_id === EMP);
    expect(entry.status).toBe("paid");
    expect(entry.payroll.monthly).toMatchObject({ rule: "semi_monthly", half: "first", semi_monthly_pay: 26100 });
    expect(entry.payroll.basic_earned).toBe(26100);
    expect(table("payroll_deductions")).toHaveLength(0);
  });

  it("commits through payroll_commit_entries and refuses a second payslip for the period", async () => {
    const submit = () => POST(request("POST", { action: "submit", pay_period: PERIOD, employee_id: EMP, basic_salary: 26100 }));
    expect((await submit()).status).toBe(200);
    expect(rpc.calls.filter((c) => c.fn === "payroll_commit_entries")).toHaveLength(1);
    expect((await submit()).status).toBe(409);
    expect(table("payroll_records")).toHaveLength(1);
  });

  it("reports a failed commit without leaving anything half-written", async () => {
    rpc.results.payroll_commit_entries = () => ({
      data: [{ employee_id: EMP, ok: false, code: "23514", error: "violates check constraint" }],
      error: null,
    });
    const response = await POST(request("POST", { action: "submit", pay_period: PERIOD, employee_id: EMP, basic_salary: 26100 }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/^Payroll was not saved/);
    expect(table("payroll_records")).toHaveLength(0);
    expect(table("payroll_entries")).toHaveLength(0);
  });

  it("is refused once the 2nd half has settled the month", async () => {
    table("payroll_entries").push({ id: "entry-oct-2", employee_id: EMP, pay_period: SECOND, status: "paid", payroll: { totals: {} } });
    const response = await POST(request("POST", { action: "submit", pay_period: PERIOD, employee_id: EMP, basic_salary: 26100 }));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("month_settled");
  });
});

describe("October 16-31, 2026 (2nd half settles the month)", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    table("payroll_entries").push(firstHalfPaid());
  });

  it("GET pre-fills the month's contributions, monthly tax, overtime, holiday pay and the 1st half paid", async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.semi_monthly).toMatchObject({ half: "second", window: { start_key: "2026-10-01", end_key: "2026-10-31" } });
    expect(body.tax_table[1]).toEqual({ over: 20833, base: 0, rate: 0.15 });
    const row = body.attendance_rows.find((r) => r.employee_id === EMP);
    expect(row.rates.daily).toBe(2400);
    expect(row.defaults).toMatchObject({
      statutory_method: "legal",
      semi_monthly: "second",
      basic_salary: 52200,
      sss: EXPECTED.sss,
      philhealth: EXPECTED.philhealth,
      pagibig: EXPECTED.pagibig,
      withholding_tax: EXPECTED.tax,
      overtime: EXPECTED.overtime,
      holiday_pay: EXPECTED.holiday,
      first_half_paid: EXPECTED.firstHalf,
    });
    expect(row.defaults.monthly).toMatchObject({
      monthly_gross: EXPECTED.monthlyGross, monthly_net: EXPECTED.monthlyNet, second_half_net: EXPECTED.secondHalf,
    });
  });

  it("processes the month less the 1st half, so the month's two payslips add up, every line traced", async () => {
    const response = await POST(request("POST", {
      action: "batch_submit",
      pay_period: SECOND,
      entries: [{ employee_id: EMP, basic_salary: 52200, deductions: { sss: EXPECTED.sss, philhealth: EXPECTED.philhealth, pagibig: EXPECTED.pagibig, withholding_tax: EXPECTED.tax } }],
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toHaveLength(1);

    const record = table("payroll_records").find((r) => r.employee_id === EMP && r.period_label === SECOND);
    expect(record.net_pay).toBe(EXPECTED.secondHalf);
    expect(record.gross_pay).toBe(EXPECTED.monthlyGross - EXPECTED.firstHalf);
    expect(record.total_deductions).toBe(EXPECTED.sss + EXPECTED.philhealth + EXPECTED.pagibig + EXPECTED.tax);

    const entry = table("payroll_entries").find((e) => e.employee_id === EMP && e.pay_period === SECOND);
    expect(entry.payroll.monthly).toMatchObject({ half: "second", first_half_paid: 26100, withholding_tax: EXPECTED.tax, carry_over_out: 0 });
    expect(entry.payroll.basic_earned).toBe(26100);

    const earnings = table("payroll_incentives").filter((l) => l.employee_id === EMP);
    expect(earnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "overtime", amount: EXPECTED.overtime, source_log_id: "o1", quantity: 120 }),
      expect.objectContaining({ type: "holiday_premium", amount: EXPECTED.holiday, source_log_id: "h1" }),
    ]));
    const tax = table("payroll_deductions").find((l) => l.employee_id === EMP && l.type === "withholding_tax");
    expect(tax).toMatchObject({ amount: EXPECTED.tax, is_override: false });
  });

  it("pays no overtime for a rejected day", async () => {
    table("attendance_overtime_approvals")[0].status = "rejected";
    table("attendance_overtime_approvals")[0].approved_minutes = 0;
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.attendance_rows.find((r) => r.employee_id === EMP).defaults.overtime).toBe(0);
  });

  it("treats a changed withholding tax as a deviation that needs a reason", async () => {
    const entry = { employee_id: EMP, basic_salary: 52200, deductions: { sss: EXPECTED.sss, philhealth: EXPECTED.philhealth, pagibig: EXPECTED.pagibig, withholding_tax: 0 } };
    const body = await (await POST(request("POST", { action: "batch_submit", pay_period: SECOND, entries: [entry] }))).json();
    expect(body.processed).toHaveLength(0);
    expect(body.skipped[0].code).toBe("override_reason_required");
  });

  it("refuses to process when no monthly tax table is set", async () => {
    table("payroll_tax_brackets").length = 0;
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    expect(body.payroll_ready).toBe(false);
  });
});

/* ── The test case: salary 32,000, divisor 261 ─────────────────────────────
   2 days absent without pay, 1 day paid leave, incentive 500, contributions
   1,200, 1st half 16,000 paid. */

describe("semi-monthly test case through the payroll API", () => {
  // The monthly table as specified (20% over 20,833), for the expected figures.
  const SPEC_TABLE = [[0, 0, 0], [20833, 0, 20], [33333, 2500, 25], [66667, 10833.33, 30]];

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    users[0].user_metadata.basic_salary = 32000;
    table("profiles")[1].basic_salary = 32000;
    table("attendance_logs").length = 0;
    table("attendance_overtime_approvals").length = 0;
    table("attendance_logs").push(
      log("a1", "2026-10-06", { status: "Absent", time_in: null, time_out: null }),
      log("a2", "2026-10-07", { status: "Absent", time_in: null, time_out: null }),
      log("l1", "2026-10-08", { status: "On Leave", time_in: null, time_out: null }),
    );
    table("leave_requests").push({
      id: "leave-1", employee_id: EMP, status: "approved", pay_status: "with_pay", leave_type: "Sick Leave",
      start_date: "2026-10-08", end_date: "2026-10-08", submitted_at: "2026-10-07T01:00:00Z",
    });
    table("payroll_monthly_incentives").push({
      id: "inc-1", employee_id: EMP, item_date: "2026-10-10", kind: "incentive", description: "Coaching",
      amount: 500, hours: null, archived: false, created_at: "2026-10-10T02:00:00Z",
    });
    table("payroll_contribution_amounts").push({
      employee_id: EMP, effective_date: "2026-10-01", sss: 900, philhealth: 200, pagibig: 100, created_at: "2026-10-01T00:00:00Z",
    });
    table("payroll_entries").push(firstHalfPaid(16000));
  });

  const monthly = async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(SECOND)}`))).json();
    return body.attendance_rows.find((r) => r.employee_id === EMP).defaults.monthly;
  };

  it("matches the expected figures with the specified tax table", async () => {
    table("payroll_tax_brackets").push(...taxRows(SPEC_TABLE, "spec", "2026-10-01", "2026-10-01T00:00:00Z"));
    expect(await monthly()).toMatchObject({
      daily_rate: 1471.26,
      absent_days: 2,
      leave_with_pay_days: 1,
      absence_deduction: 2942.52,
      incentives: 500,
      monthly_gross: 29557.48,
      contributions: 1200,
      taxable_income: 28357.48,
      withholding_tax: 1504.9,
      monthly_net: 26852.58,
      first_half_paid: 16000,
      second_half_net: 10852.58,
      net_pay: 10852.58,
    });
  });

  it("gives tax 1,128.67 and 2nd half 11,228.81 with the BIR monthly table", async () => {
    expect(await monthly()).toMatchObject({ taxable_income: 28357.48, withholding_tax: 1128.67, monthly_net: 27228.81, second_half_net: 11228.81 });
  });

  it("moves anything after the attendance lock day to next month", async () => {
    table("payroll_rate_configs").push(rate("attendance_lock_day", 28, "2026-10-01"));
    table("attendance_logs").push(log("a3", "2026-10-29", { status: "Absent", time_in: null, time_out: null }));
    // Dated before the lock but filed after it.
    table("payroll_monthly_incentives").push({
      id: "inc-2", employee_id: EMP, item_date: "2026-10-20", kind: "incentive", description: "Late filing",
      amount: 300, hours: null, archived: false, created_at: "2026-10-29T02:00:00Z",
    });
    const result = await monthly();
    expect(result).toMatchObject({ absent_days: 2, incentives: 500, window: { start_key: "2026-10-01", end_key: "2026-10-28" } });
  });

  it("carries a negative 2nd half into next month's payroll", async () => {
    table("payroll_entries")[0].payroll.totals.net_pay = 30000;
    table("payroll_entries")[0].payroll.totals.gross_pay = 30000;
    const result = await monthly();
    expect(result.second_half_net).toBe(-2771.19);
    expect(result).toMatchObject({ net_pay: 0, carry_over_out: 2771.19 });

    const response = await POST(request("POST", { action: "batch_submit", pay_period: SECOND, entries: [{ employee_id: EMP }] }));
    expect((await response.json()).processed).toHaveLength(1);
    const record = table("payroll_records").find((r) => r.period_label === SECOND);
    expect(record.net_pay).toBe(0);

    // November's 2nd half recovers it.
    vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
    const november = await (await GET(request("GET", null, `?period=${encodeURIComponent("November 16-30, 2026")}`))).json();
    expect(november.attendance_rows.find((r) => r.employee_id === EMP).defaults.monthly).toMatchObject({ carry_in: 2771.19 });
  });

  it("13th month: basic earned less unpaid absences, over 12", async () => {
    const response = await POST(request("POST", { action: "batch_submit", pay_period: SECOND, entries: [{ employee_id: EMP }] }));
    expect((await response.json()).processed).toHaveLength(1);
    // 32,000 − 2 absences (2,942.52) = 29,057.48; the paid leave day costs nothing.
    const body = await (await GET(request("GET", null, "?view=thirteenth_month&year=2026"))).json();
    expect(body.rows.find((r) => r.employee_id === EMP)).toMatchObject({ total_basic_earned: 29057.48, amount: 2421.46 });
    expect(body.can_process).toBe(false);

    const early = await PATCH(request("PATCH", { action: "process_13th_month", year: 2026 }));
    expect(early.status).toBe(403);
    vi.setSystemTime(new Date("2026-12-10T10:00:00+08:00"));
    const run = await PATCH(request("PATCH", { action: "process_13th_month", year: 2026 }));
    expect(run.status).toBe(200);
    expect(table("payroll_thirteenth_month")).toEqual([expect.objectContaining({ employee_id: EMP, year: 2026, amount: 2421.46 })]);
  });
});
