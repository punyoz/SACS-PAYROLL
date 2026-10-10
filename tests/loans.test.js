/**
 * Loans (docs/payroll-schedule-loans-awol.md §4): src/lib/payroll/loans.js,
 * the 16–end payslip deducting them (payroll route) and /api/accountant/loans.
 * The database's own rules (balance never below zero, paid at ₱0, reversal on
 * regeneration) are tested against PostgreSQL with 20261009010000/020000.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import {
  loanAppliesToPeriod,
  nextSecondHalf,
  scheduleLoans,
  suggestedAmortization,
  totalPayable,
  validateLoanInput,
} from "@/lib/payroll/loans";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const OCT2 = { start_key: "2026-10-16", end_key: "2026-10-31", label: "October 16-31, 2026" };
const loan = (fields) => ({
  id: "l1", loan_type: "salary_loan", status: "active", amortization: 2100, balance: 12600,
  start_period: "2026-10-16", date_granted: "2026-10-05", created_at: "2026-10-05T00:00:00Z", ...fields,
});

describe("Loan rules", () => {
  it("₱12,000 at 5% flat → ₱12,600 total, ₱2,100 over 6 payrolls", () => {
    expect(totalPayable(12000, 5)).toBe(12600);
    expect(suggestedAmortization(12600, 6)).toBe(2100);
    expect(suggestedAmortization(1000, 3)).toBe(333.34);   // rounded up: the last payroll is never short
  });

  it("deducts the amortization when pay covers it", () => {
    const r = scheduleLoans({ loans: [loan()], period: OCT2, available: 9000 });
    expect(r.total).toBe(2100);
    expect(r.lines[0]).toMatchObject({ amount: 2100, shortfall: 0, balance_before: 12600, balance_after: 10500 });
  });

  it("partial when pay is short; the rest stays on the balance (worked example 7.3)", () => {
    const r = scheduleLoans({ loans: [loan({ balance: 10500 })], period: OCT2, available: 606.9 });
    expect(r.lines[0]).toMatchObject({ due: 2100, amount: 606.9, shortfall: 1493.1, balance_after: 9893.1 });
  });

  it("nothing when net pay is zero or negative (no negative payslip)", () => {
    expect(scheduleLoans({ loans: [loan()], period: OCT2, available: -4350 }).total).toBe(0);
  });

  it("never more than the balance (last payroll)", () => {
    expect(scheduleLoans({ loans: [loan({ balance: 300 })], period: OCT2, available: 9000 }).lines[0].amount).toBe(300);
  });

  it("oldest loan first", () => {
    const r = scheduleLoans({
      loans: [loan({ id: "new", date_granted: "2026-10-09" }), loan({ id: "old", date_granted: "2026-09-01" })],
      period: OCT2, available: 3000,
    });
    expect(r.lines.map((l) => [l.loan_id, l.amount])).toEqual([["old", 2100], ["new", 900]]);
  });

  it("skips suspended loans, subsidy advances, loans not started yet, and the 1st half", () => {
    expect(loanAppliesToPeriod(loan({ status: "suspended" }), OCT2)).toBe(false);
    expect(loanAppliesToPeriod(loan({ loan_type: "subsidy_advance" }), OCT2)).toBe(false);
    expect(loanAppliesToPeriod(loan({ start_period: "2026-11-16" }), OCT2)).toBe(false);
    expect(loanAppliesToPeriod(loan(), { start_key: "2026-11-01" })).toBe(false);
    expect(loanAppliesToPeriod(loan(), OCT2)).toBe(true);
  });

  it("validates a new loan", () => {
    const ok = { loan_type: "salary_loan", principal: 12000, interest_pct: 5, number_of_payrolls: 6, amortization: 2100, date_granted: "2026-10-05", start_period: "2026-10-16" };
    expect(validateLoanInput(ok)).toBe(null);
    expect(validateLoanInput({ ...ok, start_period: "2026-11-01" })).toMatch(/16–end/);
    expect(validateLoanInput({ ...ok, amortization: 13000 })).toMatch(/more than the total/);
    expect(validateLoanInput({ ...ok, loan_type: "subsidy_advance" })).toMatch(/type/);
    expect(validateLoanInput({ ...ok, number_of_payrolls: 0 })).toMatch(/payrolls/);
  });

  it("next 2nd half", () => {
    expect(nextSecondHalf("2026-10-09")).toBe("2026-10-16");
    expect(nextSecondHalf("2026-10-16")).toBe("2026-10-16");
    expect(nextSecondHalf("2026-12-20")).toBe("2027-01-16");
  });
});

/* ── The 16–end payslip deducts loans ─────────────────────────────────────── */

const BRANCH = "b-main";
const OTHER = "b-other";
const NATE = "u-nate";
const FAR = "u-far";
const SECOND = "October 16-31, 2026";
const FIRST = "October 1-15, 2026";
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null,
  value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});
const log = (id, employeeId, date, fields = {}) => ({
  id, employee_id: employeeId, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`,
  created_at: `${date}T00:00:00Z`, status: "On Time", late_minutes: 0, undertime_minutes: 0,
  is_half_day: false, is_early_bird: false, archived_duplicate: false, ...fields,
});

let payroll;
let loansApi;
let createSessionToken;
let SESSION_COOKIE;

const who = {
  accountant: { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" },
  admin: { user_id: "u-adm", role: "admin", branch_id: BRANCH, full_name: "Ada Admin" },
  employee: { user_id: NATE, role: "employee", branch_id: BRANCH, full_name: "Angelica Nate" },
  super: { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" },
};
function request(path, method, body, as = who.accountant, query = "") {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: "s-1" });
  return new Request(`https://sacs.test${path}${query}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const seedLoan = (fields = {}) => table("payroll_loans").push({
  id: "loan-nate", employee_id: NATE, branch_id: BRANCH, loan_type: "salary_loan", description: "Salary loan",
  date_granted: "2026-10-05", principal: 12000, interest_pct: 5, total_payable: 12600, amortization: 2100,
  number_of_payrolls: 6, start_period: "2026-10-16", remaining_balance: 12600, status: "active",
  created_at: "2026-10-05T00:00:00Z", ...fields,
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-loans";
  resetDb();
  users.push(
    { id: NATE, email: "nate@sacs.test", user_metadata: { role: "employee", full_name: "Angelica Nate", employee_id: "SACS-001", basic_salary: 10500, branch_id: BRANCH } },
    { id: FAR, email: "far@sacs.test", user_metadata: { role: "employee", full_name: "Far Away", employee_id: "SACS-009", basic_salary: 10000, branch_id: OTHER } },
  );
  table("branches").push({ id: BRANCH, name: "Main" }, { id: OTHER, name: "Other" });
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH },
    { id: "u-adm", branch_id: BRANCH },
    { id: NATE, full_name: "Angelica Nate", email: "nate@sacs.test", branch_id: BRANCH, role: "employee", employee_type: "Teaching" },
    { id: FAR, full_name: "Far Away", email: "far@sacs.test", branch_id: OTHER, role: "employee", employee_type: "Teaching" },
  );
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
  // Absent Oct 5, half day Oct 6 → net before loans ₱3,993.75 (school sheet test).
  table("attendance_logs").push(
    log("n1", NATE, "2026-10-02"),
    log("n2", NATE, "2026-10-05", { status: "Absent", time_in: null, time_out: null }),
    log("n3", NATE, "2026-10-06", { status: "Half Day", is_half_day: true }),
  );
  table("payroll_entries").push({
    id: "first-nate", employee_id: NATE, employee_name: NATE, pay_period: FIRST, status: "paid", payslip_no: "PS-202610-1",
    payroll: { basic_salary: 5250, basic_earned: 5250, totals: { gross_pay: 5250, total_deductions: 0, total_incentives: 0, net_pay: 5250 } },
  });
  table("payroll_cash_advances");   // exists, empty (as on live)

  payroll = await import("@/app/api/accountant/payroll/route");
  loansApi = await import("@/app/api/accountant/loans/route");
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => { vi.useRealTimers(); });

const process2nd = () => payroll.POST(request("/api/accountant/payroll", "POST", {
  action: "batch_submit", pay_period: SECOND,
  entries: [{ employee_id: NATE, basic_salary: 10500, deductions: { sss: 400, philhealth: 0, pagibig: 200, withholding_tax: 0 } }],
}));

describe("The 16–end payslip deducts loans", () => {
  it("pre-fills the loan; processing deducts ₱2,100, writes the repayment, balance ₱10,500", async () => {
    seedLoan();
    const body = await (await payroll.GET(request("/api/accountant/payroll", "GET", null, who.accountant, `?period=${encodeURIComponent(SECOND)}`))).json();
    const row = body.attendance_rows.find((r) => r.employee_id === NATE);
    expect(row.defaults.loan).toBe(2100);
    expect(row.defaults.monthly.second_half_net).toBe(1893.75);

    const response = await process2nd();
    expect(response.status).toBe(200);
    expect(table("payroll_records").find((r) => r.employee_id === NATE).net_pay).toBe(1893.75);
    expect(table("payroll_deductions").find((l) => l.employee_id === NATE && l.type === "loan")).toMatchObject({ amount: 2100 });
    expect(table("payroll_loan_payments")).toEqual([expect.objectContaining({ loan_id: "loan-nate", kind: "payroll", amount: 2100, period_start: "2026-10-16" })]);
    expect(table("payroll_loans")[0].remaining_balance).toBe(10500);
    const entry = table("payroll_entries").find((e) => e.employee_id === NATE && e.pay_period === SECOND);
    expect(entry.payroll.loans[0]).toMatchObject({ amount: 2100, balance_after: 10500 });
    expect(entry.payroll.totals.net_pay).toBe(1893.75);
  });

  it("partial when pay is short: deducts ₱3,993.75 of ₱5,000, net ₱0, the rest stays", async () => {
    seedLoan({ amortization: 5000 });
    expect((await process2nd()).status).toBe(200);
    expect(table("payroll_records").find((r) => r.employee_id === NATE).net_pay).toBe(0);
    const line = table("payroll_deductions").find((l) => l.type === "loan");
    expect(line.amount).toBe(3993.75);
    expect(line.note).toContain("partial");
    expect(table("payroll_loans")[0].remaining_balance).toBe(8606.25);
  });

  it("a suspended loan is skipped", async () => {
    seedLoan({ status: "suspended" });
    expect((await process2nd()).status).toBe(200);
    expect(table("payroll_deductions").some((l) => l.type === "loan")).toBe(false);
    expect(table("payroll_records").find((r) => r.employee_id === NATE).net_pay).toBe(3993.75);
  });
});

/* ── /api/accountant/loans ───────────────────────────────────────────────── */

const createLoan = (body = {}, as = who.accountant) => loansApi.POST(request("/api/accountant/loans", "POST", {
  action: "create_loan", employee_id: NATE, loan_type: "salary_loan", principal: 12000, interest_pct: 5,
  number_of_payrolls: 6, amortization: "", date_granted: "2026-11-02", start_period: "2026-11-16", ...body,
}, as));

describe("Loans API", () => {
  it("the Accountant adds a loan; the amortization defaults to total ÷ payrolls", async () => {
    const response = await createLoan();
    expect(response.status).toBe(200);
    expect(table("payroll_loans")[0]).toMatchObject({ employee_id: NATE, principal: 12000, interest_pct: 5, amortization: 2100, start_period: "2026-11-16", created_by: "u-acct" });
    expect(table("audit_logs").some((a) => a.action === "loan_create")).toBe(true);
  });

  it("refuses a 1st-half start, a period already over, and another branch's employee", async () => {
    expect((await createLoan({ start_period: "2026-11-01" })).status).toBe(400);
    expect((await createLoan({ start_period: "2026-10-16" })).status).toBe(400);
    expect((await createLoan({ employee_id: FAR })).status).toBe(404);
  });

  it("refuses a start period whose payslip is already Final", async () => {
    table("payroll_entries").push({ id: "nov2", employee_id: NATE, pay_period: "November 16-30, 2026", status: "paid", payroll: {} });
    expect((await createLoan()).status).toBe(409);
  });

  it("the Admin can view but not add; an employee sees only their own loans", async () => {
    seedLoan();
    table("payroll_loans").push({ id: "loan-far", employee_id: FAR, branch_id: OTHER, loan_type: "salary_loan", principal: 1000, remaining_balance: 1000, status: "active", date_granted: "2026-10-01" });
    expect((await createLoan({}, who.admin)).status).toBe(403);
    const admin = await (await loansApi.GET(request("/api/accountant/loans", "GET", null, who.admin))).json();
    expect(admin.loans.map((l) => l.id)).toEqual(["loan-nate"]);
    expect(admin.can_edit).toBe(false);
    const own = await (await loansApi.GET(request("/api/accountant/loans", "GET", null, who.employee))).json();
    expect(own.loans.map((l) => l.id)).toEqual(["loan-nate"]);
    expect(own.people).toEqual([]);
    const all = await (await loansApi.GET(request("/api/accountant/loans", "GET", null, who.super))).json();
    expect(all.loans).toHaveLength(2);
  });

  it("suspend needs a reason; resume; a paid loan cannot change", async () => {
    seedLoan();
    const patch = (body) => loansApi.PATCH(request("/api/accountant/loans", "PATCH", { loan_id: "loan-nate", action: "set_status", ...body }));
    expect((await patch({ status: "suspended" })).status).toBe(400);
    expect((await patch({ status: "suspended", reason: "Teacher on approved leave" })).status).toBe(200);
    expect(table("payroll_loans")[0]).toMatchObject({ status: "suspended", status_reason: "Teacher on approved leave" });
    expect((await patch({ status: "active" })).status).toBe(200);
    table("payroll_loans")[0].status = "paid";
    expect((await patch({ status: "suspended", reason: "whatever" })).status).toBe(409);
  });

  it("a subsidy advance must fit the teacher's available balance", async () => {
    table("payroll_subsidy_balances").push({
      id: "bal-1", employee_id: NATE, subsidy_year_start: "2026-01-01", status: "open", annual_amount: 24000,
      entitlement: 24000, advances_total: 20000, paid_out: 0, remaining: 4000, advance_limit: "full_year", eligible_from: "2026-01-01", eligible_months: 12,
    });
    const advance = (principal) => loansApi.POST(request("/api/accountant/loans", "POST", {
      action: "create_subsidy_advance", employee_id: NATE, subsidy_balance_id: "bal-1", principal, date_granted: "2026-11-02",
    }));
    expect((await advance(4000.01)).status).toBe(400);
    expect((await advance(4000)).status).toBe(200);
    expect(table("payroll_loans")[0]).toMatchObject({ loan_type: "subsidy_advance", principal: 4000, subsidy_balance_id: "bal-1" });
  });

  it("excess subsidy advance: refusal goes to HR / Admin; conversion needs signed consent", async () => {
    table("payroll_subsidy_balances").push({ id: "bal-2", employee_id: NATE, status: "open", remaining: -2000 });
    seedLoan({ id: "adv", loan_type: "subsidy_advance", subsidy_balance_id: "bal-2", remaining_balance: 10000, amortization: null, start_period: null });
    const patch = (body) => loansApi.PATCH(request("/api/accountant/loans", "PATCH", { loan_id: "adv", ...body }));
    expect((await patch({ action: "convert_excess" })).status).toBe(400);
    expect((await patch({ action: "record_refusal", reason: "no" })).status).toBe(400);
    expect((await patch({ action: "record_refusal", reason: "Will not sign; asks for offset" })).status).toBe(200);
    expect(table("payroll_loans").find((l) => l.id === "adv")).toMatchObject({ status: "suspended", awaiting_decision: true });
    expect((await patch({ action: "set_status", status: "active" })).status).toBe(409);
  });
});
