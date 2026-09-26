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
 * Earlier periods keep the old flat-% rules; tests/payroll-attendance-route.test.js
 * pins those.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
//   SSS: credit capped at 35,000 × 5% = 1,750 → 875; PhilHealth 52,200 ×
//   2.5% = 1,305 → 652.50; Pag-IBIG 10,000 × 2% = 200 → 100.
//   Overtime: 120 approved min × 300 × 125% = 750. Holiday (Oct 5, 9 h):
//   100% × 2,400 = 2,400. Taxable: 26,100 + 3,150 − 1,627.50 = 27,622.50 →
//   tax 937.50 + 20% × (27,622.50 − 16,667) = 3,128.60.
const EXPECTED = {
  sss: 875, philhealth: 652.5, pagibig: 100, tax: 3128.6, overtime: 750, holiday: 2400,
  gross: 26100 + 750 + 2400,
};
EXPECTED.deductions = EXPECTED.sss + EXPECTED.philhealth + EXPECTED.pagibig + EXPECTED.tax;

beforeEach(async () => {
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
  table("attendance_holidays").push({ holiday_date: "2026-10-05", name: "Test Holiday", type: "holiday" });
  table("attendance_logs").push(
    log("o1", "2026-10-01", { time_out: "2026-10-01T12:00:00Z" }),
    log("h1", "2026-10-05"),
  );
  table("attendance_overtime_approvals").push({ log_id: "o1", employee_id: EMP, log_date: "2026-10-01", overtime_minutes: 180, approved_minutes: 120, status: "approved" });

  ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("October 1-15, 2026", () => {
  it("GET pre-fills the legal contributions, tax, overtime and holiday pay", async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(PERIOD)}`))).json();
    expect(body.legal_rules).toBe(true);
    expect(body.tax_table).toEqual(SEMI_MONTHLY_TAX_TABLE);
    const row = body.attendance_rows.find((r) => r.employee_id === EMP);
    expect(row.rates.daily).toBe(2400);
    expect(row.defaults).toMatchObject({
      statutory_method: "legal",
      basic_salary: 26100,
      sss: EXPECTED.sss,
      philhealth: EXPECTED.philhealth,
      pagibig: EXPECTED.pagibig,
      withholding_tax: EXPECTED.tax,
      overtime: EXPECTED.overtime,
      holiday_pay: EXPECTED.holiday,
    });
  });

  it("processes the payslip with gross pay including overtime and holiday pay, every line traced", async () => {
    const response = await POST(request("POST", {
      action: "batch_submit",
      pay_period: PERIOD,
      entries: [{ employee_id: EMP, basic_salary: 26100, deductions: { sss: EXPECTED.sss, philhealth: EXPECTED.philhealth, pagibig: EXPECTED.pagibig, withholding_tax: EXPECTED.tax } }],
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toHaveLength(1);
    expect(body.processed[0].payslip_no).toMatch(/^PS-\d{6}-0001$/);

    const record = table("payroll_records").find((r) => r.employee_id === EMP);
    expect(record.gross_pay).toBe(EXPECTED.gross);
    expect(record.total_deductions).toBe(EXPECTED.deductions);
    expect(record.net_pay).toBe(EXPECTED.gross - EXPECTED.deductions);

    const entry = table("payroll_entries").find((e) => e.employee_id === EMP);
    expect(entry.status).toBe("paid");
    expect(entry.payslip_no).toBe(record.payslip_no);
    expect(entry.payroll.allowances).toMatchObject({ overtime: EXPECTED.overtime, holiday_pay: EXPECTED.holiday });

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
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(PERIOD)}`))).json();
    expect(body.attendance_rows.find((r) => r.employee_id === EMP).defaults.overtime).toBe(0);
  });

  it("treats a changed withholding tax as a deviation that needs a reason", async () => {
    const entry = { employee_id: EMP, basic_salary: 26100, deductions: { sss: EXPECTED.sss, philhealth: EXPECTED.philhealth, pagibig: EXPECTED.pagibig, withholding_tax: 0 } };
    const body = await (await POST(request("POST", { action: "batch_submit", pay_period: PERIOD, entries: [entry] }))).json();
    expect(body.processed).toHaveLength(0);
    expect(body.skipped[0].code).toBe("override_reason_required");
  });

  it("commits through payroll_commit_entries and refuses a second payslip for the period", async () => {
    const submit = () => POST(request("POST", {
      action: "submit", pay_period: PERIOD, employee_id: EMP, basic_salary: 26100,
      deductions: { sss: EXPECTED.sss, philhealth: EXPECTED.philhealth, pagibig: EXPECTED.pagibig, withholding_tax: EXPECTED.tax },
    }));
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
    const response = await POST(request("POST", {
      action: "submit", pay_period: PERIOD, employee_id: EMP, basic_salary: 26100,
      deductions: { sss: EXPECTED.sss, philhealth: EXPECTED.philhealth, pagibig: EXPECTED.pagibig, withholding_tax: EXPECTED.tax },
    }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/^Payroll was not saved/);
    expect(table("payroll_records")).toHaveLength(0);
    expect(table("payroll_entries")).toHaveLength(0);
  });
});
