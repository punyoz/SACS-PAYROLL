/**
 * Loans (docs/payroll-schedule-loans-awol.md §4): src/lib/payroll/loans.js,
 * the 16–end payslip deducting them (payroll route) and /api/accountant/loans.
 * The database's own rules (balance never below zero, paid at ₱0, reversal on
 * regeneration) are tested against PostgreSQL with 20261009010000/020000.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";
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

  // 2026-10-20: loans are payroll (the Accountant's); the Admin and the
  // Super Admin have no access.
  it("the Admin and the Super Admin have no access; an employee sees only their own loans", async () => {
    seedLoan();
    table("payroll_loans").push({ id: "loan-far", employee_id: FAR, branch_id: OTHER, loan_type: "salary_loan", principal: 1000, remaining_balance: 1000, status: "active", date_granted: "2026-10-01" });
    expect((await createLoan({}, who.admin)).status).toBe(403);
    expect((await loansApi.GET(request("/api/accountant/loans", "GET", null, who.admin))).status).toBe(403);
    const own = await (await loansApi.GET(request("/api/accountant/loans", "GET", null, who.employee))).json();
    expect(own.loans.map((l) => l.id)).toEqual(["loan-nate"]);
    expect(own.people).toEqual([]);
    expect((await loansApi.GET(request("/api/accountant/loans", "GET", null, who.super))).status).toBe(403);
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

  // 2026-10-21: the Accountant processes, HR approves (20261021010000).
  it("a subsidy advance must fit the available balance, and is only processed: no loan until HR approves", async () => {
    table("payroll_subsidy_balances").push({
      id: "bal-1", employee_id: NATE, subsidy_year_start: "2026-01-01", status: "open", annual_amount: 24000,
      entitlement: 24000, advances_total: 20000, paid_out: 0, remaining: 4000, advance_limit: "full_year", eligible_from: "2026-01-01", eligible_months: 12,
    });
    rpc.results.subsidy_request_process = (args) => ({ data: { id: "req-1", status: "processed", ...args }, error: null });
    const advance = (principal) => loansApi.POST(request("/api/accountant/loans", "POST", {
      action: "create_subsidy_advance", employee_id: NATE, subsidy_balance_id: "bal-1", principal, date_granted: "2026-11-02",
    }));
    expect((await advance(4000.01)).status).toBe(400);
    const res = await advance(4000);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "processed", request_id: "req-1" });
    expect(table("payroll_loans")).toHaveLength(0);
    expect(rpc.calls.find((c) => c.fn === "subsidy_request_process").args).toMatchObject({
      p_kind: "advance", p_employee_id: NATE, p_balance_id: "bal-1", p_amount: 4000, p_details: expect.objectContaining({ date_granted: "2026-11-02" }),
    });
  });

  it("excess subsidy advance: a refusal or a signed conversion is processed for HR, never applied here", async () => {
    table("payroll_subsidy_balances").push({ id: "bal-2", employee_id: NATE, status: "open", remaining: -2000 });
    seedLoan({ id: "adv", loan_type: "subsidy_advance", subsidy_balance_id: "bal-2", remaining_balance: 10000, amortization: null, start_period: null });
    rpc.results.subsidy_request_process = (args) => ({ data: { id: "req-2", status: "processed", ...args }, error: null });
    const patch = (body) => loansApi.PATCH(request("/api/accountant/loans", "PATCH", { loan_id: "adv", ...body }));
    expect((await patch({ action: "convert_excess" })).status).toBe(400);   // no signed consent
    expect((await patch({ action: "record_refusal", reason: "no" })).status).toBe(400);
    expect((await patch({ action: "record_refusal", reason: "Will not sign; asks for offset", option: "offset_next_subsidy" })).status).toBe(200);
    expect(rpc.calls.find((c) => c.fn === "subsidy_request_process").args).toMatchObject({
      p_kind: "excess_settlement", p_loan_id: "adv", p_details: { option: "offset_next_subsidy" },
    });
    expect((await patch({ action: "convert_excess", consent_signed: true, number_of_payrolls: 2 })).status).toBe(200);
    expect(rpc.calls.filter((c) => c.fn === "subsidy_request_process").at(-1).args.p_details).toMatchObject({ option: "convert", consent_signed: true, number_of_payrolls: 2 });
    // Nothing was written to the loan by the route itself.
    expect(table("payroll_loans").find((l) => l.id === "adv")).not.toHaveProperty("decision");
    expect(table("payroll_loan_payments")).toHaveLength(0);
  });
});

/* ── 2026-11-19: the export is the table; pending loans; who can be suspended ── */

/** The worksheets of an .xlsx (a ZIP of XML parts). */
async function sheetOf(response) {
  const { inflateRawSync } = await import("node:zlib");
  const buffer = Buffer.from(await response.arrayBuffer());
  const files = {};
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extra = buffer.readUInt16LE(at + 28);
    const name = buffer.slice(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extra;
    files[name] = inflateRawSync(buffer.slice(start, start + size)).toString("utf8");
    at = start + size;
  }
  const xml = files["xl/worksheets/sheet1.xml"];
  // Each cell in its column (Excel leaves empty cells out); rowNo: the sheet row of each.
  const parsed = [...xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)].map((m) => {
    const cells = [];
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<f>(.*?)<\/f>(?:<v>(.*?)<\/v>)?|<v>(.*?)<\/v>)<\/c>/g)) {
      cells[c[1].charCodeAt(0) - 65] = c[2] ?? (c[3] ? `=${c[3]}` : c[5]);
    }
    return { rowNo: Number(m[1]), cells };
  });
  return { xml, rows: parsed.map((r) => r.cells), rowNos: parsed.map((r) => r.rowNo) };
}

describe("Loans export = the Loans table (2026-11-19)", () => {
  const exportLoans = (query) => loansApi.GET(request("/api/accountant/loans", "GET", null, who.accountant, `?format=xlsx&${query}`));
  const screen = async () => (await (await loansApi.GET(request("/api/accountant/loans", "GET", null, who.accountant))).json()).loans;
  const seedThree = () => {
    seedLoan({ approval_status: "approved", decided_by_name: "Demo HR One", decided_at: "2026-11-15T02:00:00Z", decision_note: "Approved." });
    table("payroll_loans").push(
      { id: "loan-pend", employee_id: NATE, branch_id: BRANCH, loan_type: "salary_loan", description: "Tuition", date_granted: "2026-11-19", principal: 1000, interest_pct: 0, total_payable: 1000, amortization: 166.67, number_of_payrolls: 6, start_period: "2026-11-16", remaining_balance: 1000, status: "active", approval_status: "pending", created_at: "2026-11-19T00:00:00Z" },
      { id: "loan-rej", employee_id: NATE, branch_id: BRANCH, loan_type: "emergency_loan", description: "Emergency", date_granted: "2026-11-15", principal: 4000, interest_pct: 0, total_payable: 4000, amortization: 2000, number_of_payrolls: 2, start_period: "2026-11-16", remaining_balance: 4000, status: "active", approval_status: "rejected", decided_by_name: "Demo HR One", decision_note: "Not within this year's limit.", created_at: "2026-11-15T00:00:00Z" },
    );
  };

  it("Status All, no search: every row the table lists, the table's columns, readable filters, totals", async () => {
    seedThree();
    const { rows, rowNos, xml } = await sheetOf(await exportLoans("status=all"));
    expect(xml).toContain("Branch: Main · As of Nov 2, 2026");
    expect(xml).toContain("Filters: Status: All · Search: none · Sorted by: Given (newest first)");
    expect(xml).toContain("3 records");
    expect(xml).not.toMatch(/S: t|Own branch/);
    const header = rows.find((r) => r[0] === "Employee");
    expect(header).toEqual(["Employee", "Employee ID", "Type", "Description", "Given", "Total payable", "Per 16–end payslip", "Deducted from", "Repaid", "Balance", "Status", "HR decision"]);
    const body = rows.slice(rows.indexOf(header) + 1);
    const listed = await screen();
    expect(body).toHaveLength(listed.length + 1); // + the totals row
    // The list's own order (newest given first), the same loans.
    expect(body.slice(0, 3).map((r) => r[3])).toEqual(["Tuition", "Emergency", "Salary loan"]);
    expect(body[2][11]).toBe("Approved by Demo HR One · Nov 15, 2026"); // "Approved." is not repeated
    expect(body[1][11]).toBe("Rejected by Demo HR One: Not within this year's limit.");
    // Totals: Total payable, Repaid, Balance as formulas; never the per-payslip amount.
    const totals = body.at(-1);
    const first = rowNos[rows.indexOf(header) + 1];
    expect(totals[0]).toBe("TOTAL");
    expect(totals[5]).toBe(`=SUM(F${first}:F${first + 2})`);
    expect(totals[6]).toBeUndefined();
    expect(totals[9]).toBe(`=SUM(J${first}:J${first + 2})`);
    // Money is a number with the ₱ format; Given is a real date.
    expect(xml).toContain(`<c r="F${first}" s="4"><v>1000</v></c>`);
    expect(xml).toContain(`<c r="E${first}" s="5"><v>46345</v></c>`); // Nov 19, 2026
  });

  it("a search and a status: the same rows as the filtered table, in its sort, said in words", async () => {
    seedThree();
    users.push({ id: "u-bea", email: "bea@sacs.test", user_metadata: { role: "employee", full_name: "Bea Cruz", employee_id: "SACS-002", branch_id: BRANCH } });
    table("profiles").push({ id: "u-bea", full_name: "Bea Cruz", email: "bea@sacs.test", branch_id: BRANCH, role: "employee", employee_type: "Teaching" });
    table("payroll_loans").push({ id: "loan-bea", employee_id: "u-bea", branch_id: BRANCH, loan_type: "salary_loan", description: "Books", date_granted: "2026-10-01", principal: 3000, interest_pct: 0, total_payable: 3000, amortization: 500, number_of_payrolls: 6, start_period: "2026-10-16", remaining_balance: 2500, status: "active", approval_status: "approved", created_at: "2026-10-01T00:00:00Z" });
    const { rows, xml } = await sheetOf(await exportLoans("status=open&q=nate&sort=balance:desc"));
    expect(xml).toContain("Filters: Status: Open · Search: nate · Sorted by: Balance (highest first)");
    const header = rows.find((r) => r[0] === "Employee");
    const body = rows.slice(rows.indexOf(header) + 1, -1);
    expect(body.map((r) => r[0])).toEqual(["Angelica Nate", "Angelica Nate"]); // Bea is not "nate"; the rejected loan is not Open
    expect(body.map((r) => Number(r[9]))).toEqual([12600, 1000]);
  });

  it("more rows than one page: every matching loan is in the file", async () => {
    for (let i = 0; i < 27; i += 1) {
      table("payroll_loans").push({ id: `loan-${i}`, employee_id: NATE, branch_id: BRANCH, loan_type: "salary_loan", description: `Loan ${i}`, date_granted: "2026-10-01", principal: 100, interest_pct: 0, total_payable: 100, amortization: 50, number_of_payrolls: 2, start_period: "2026-10-16", remaining_balance: 100, status: "active", approval_status: "approved", created_at: "2026-10-01T00:00:00Z" });
    }
    const { xml } = await sheetOf(await exportLoans("status=all"));
    expect(xml).toContain("27 records");
    for (let i = 0; i < 27; i += 1) expect(xml).toContain(`>Loan ${i}<`);
  });

  it("an empty export says why", async () => {
    seedThree();
    const { xml } = await sheetOf(await exportLoans("status=paid"));
    expect(xml).toContain("No loans match: Status = Paid.");
    expect(xml).toContain("0 records");
  });

  it("a pending loan is never deducted until HR approves it", async () => {
    seedLoan({ approval_status: "pending" });
    expect((await process2nd()).status).toBe(200);
    expect(table("payroll_loan_payments")).toHaveLength(0);
    expect(table("payroll_deductions").some((l) => l.employee_id === NATE && l.type === "loan")).toBe(false);
    expect(table("payroll_loans")[0].remaining_balance).toBe(12600);
  });

  it("only an approved, active loan can be suspended; rejected, pending and paid ones are refused", async () => {
    const { loanCanSuspend, loanCanResume } = await import("@/lib/payroll/loan-status");
    const patch = (id) => loansApi.PATCH(request("/api/accountant/loans", "PATCH", { loan_id: id, action: "set_status", status: "suspended", reason: "Teacher on approved leave" }));
    seedThree();
    expect((await patch("loan-rej")).status).toBe(409);
    expect((await patch("loan-pend")).status).toBe(409);
    expect(table("payroll_loans").find((l) => l.id === "loan-rej").status).toBe("active");
    expect(loanCanSuspend(table("payroll_loans").find((l) => l.id === "loan-rej"))).toBe(false);
    expect(loanCanSuspend({ status: "paid", approval_status: "approved", loan_type: "salary_loan" })).toBe(false);
    expect((await patch("loan-nate")).status).toBe(200);
    expect(loanCanResume(table("payroll_loans").find((l) => l.id === "loan-nate"))).toBe(true);
  });
});

/* ── Loan limit (2026-11-25, 20261126050000) ───────────────────────────────── */

describe("Loan salary limit", () => {
  // The database's loan_limit_overview, mirrored: limit = salary × 1.0, owed = the remaining principal
  // (never interest) of unpaid counted loans: remaining balance × principal ÷ total payable.
  const SALARY = { [NATE]: 10500 };
  const fakeOverview = ({ p_employee_ids: ids, p_exclude: exclude }) => ({
    data: ids.map((id) => {
      const owed = table("payroll_loans").filter((l) => l.employee_id === id && l.id !== exclude
        && ["salary_loan", "emergency_loan", "other"].includes(l.loan_type) && l.status !== "paid"
        && ["pending", "approved", undefined].includes(l.approval_status))
        .reduce((sum, l) => {
          const principal = Number(l.principal) || 0;
          const total = principal + Math.round(principal * (Number(l.interest_pct) || 0)) / 100;
          const balance = Number(l.remaining_balance ?? total);
          return sum + (total > 0 ? Math.round((balance * principal / total) * 100) / 100 : 0);
        }, 0);
      const limit = SALARY[id] || 0;
      return { employee_id: id, monthly_basic: limit, multiplier: 1, loan_limit: limit, owed, room: limit - owed };
    }),
    error: null,
  });
  beforeEach(() => { rpc.results.loan_limit_overview = fakeOverview; });
  const plain = (body) => createLoan({ interest_pct: 0, ...body });

  it("messages: summary and refusal in plain words", async () => {
    const { loanLimitSummary, loanLimitRefusal, checkLoanLimit } = await import("@/lib/payroll/loan-limit");
    const info = { loan_limit: 10500, owed: 4000, multiplier: 1 };
    expect(loanLimitSummary(info)).toBe("Salary limit ₱10,500.00, already owed ₱4,000.00, you can borrow up to ₱6,500.00.");
    expect(loanLimitRefusal(info, 7000)).toBe("This loan would make the total ₱11,000.00, which is more than the limit of ₱10,500.00 (1 month's salary). The most that can be added is ₱6,500.00.");
    expect(checkLoanLimit({ ...info, amount: 6500 }).ok).toBe(true);
    expect(checkLoanLimit({ ...info, amount: 6500.01 }).ok).toBe(false);
  });

  it("below the limit and exactly at it: allowed; one peso above: refused and audited", async () => {
    expect((await plain({ principal: 10500 })).status).toBe(200);           // exactly at
    table("payroll_loans").length = 0;
    expect((await plain({ principal: 5000 })).status).toBe(200);            // below
    table("payroll_loans").length = 0;
    const over = await plain({ principal: 10501 });
    expect(over.status).toBe(400);
    const body = await over.json();
    expect(body.code).toBe("loan_limit");
    expect(body.error).toContain("The most that can be added is ₱10,500.00");
    expect(table("payroll_loans")).toHaveLength(0);
    const audit = table("audit_logs").find((a) => a.action === "loan_limit_refused");
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).toContain("10500");
  });

  it("two loans that together exceed: the second is refused; a pending one counts; a paid one does not", async () => {
    expect((await plain({ principal: 6000 })).status).toBe(200);            // stays pending
    expect((await plain({ principal: 5000 })).status).toBe(400);            // 6,000 pending + 5,000 > 10,500
    table("payroll_loans")[0].status = "paid";
    table("payroll_loans")[0].remaining_balance = 0;
    expect((await plain({ principal: 5000 })).status).toBe(200);            // paid loan no longer counts
  });

  it("only the amount borrowed counts, never interest; cash advances are not limited here", async () => {
    // 10,500 at 10% (total payable 11,550) fits a limit of 10,500: interest is not counted (decision 2026-11-25).
    expect((await createLoan({ principal: 10500, interest_pct: 10 })).status).toBe(200);
    table("payroll_loans")[0].remaining_balance = 5775;   // half repaid: 5,250 of principal still borrowed
    expect((await plain({ principal: 5251 })).status).toBe(400);
    expect((await plain({ principal: 5250 })).status).toBe(200);
    table("payroll_loans").length = 0;
    expect((await plain({ loan_type: "cash_advance", principal: 20000 })).status).toBe(200);
  });

  it("the database's own refusal (e.g. two filed at once) is shown and audited the same way", async () => {
    const { loanLimitDbRefusal } = await import("@/lib/payroll/loan-limit");
    const refusal = loanLimitDbRefusal({ code: "23514", message: "loan_limit: This loan would make the total ₱11,000.00, which is more than the limit of ₱10,500.00 (1 month's salary). The most that can be added is ₱6,500.00.", details: "{\"loan_limit\":10500,\"owed\":4500}" });
    expect(refusal.error.startsWith("This loan would make")).toBe(true);
    expect(refusal.detail).toMatchObject({ loan_limit: 10500, owed: 4500 });
    expect(loanLimitDbRefusal({ message: "other" })).toBeNull();
  });

  it("GET gives each person their limit, and the employee their own", async () => {
    seedLoan({ principal: 4000, interest_pct: 0, total_payable: 4000, remaining_balance: 4000, approval_status: "approved" });
    const data = await (await loansApi.GET(request("/api/accountant/loans", "GET"))).json();
    expect(data.people.find((p) => p.id === NATE).loan_limit).toMatchObject({ loan_limit: 10500, owed: 4000, room: 6500 });
    const own = await (await loansApi.GET(request("/api/accountant/loans", "GET", null, who.employee))).json();
    expect(own.my_loan_limit).toMatchObject({ loan_limit: 10500, owed: 4000 });
  });

  it("HR approval refused by the database is a plain 400 with the reason", async () => {
    const { describeDecisionError } = await import("@/lib/payroll/adjustment-approvals");
    const failure = describeDecisionError({ message: "loan_limit: This loan would make the total ₱20,000.00, which is more than the limit of ₱19,000.00 (1 month's salary). The most that can be added is ₱19,000.00." });
    expect(failure).toMatchObject({ status: 400, code: "loan_limit" });
    expect(failure.error.startsWith("This loan would make the total")).toBe(true);
  });

  it("nobody files a loan for themselves (unchanged)", async () => {
    users.push({ id: "u-acct", email: "u-acct@sacs.test", user_metadata: { role: "accountant", full_name: "Ana Accountant", branch_id: BRANCH } });
    expect((await plain({ employee_id: "u-acct", principal: 100 })).status).toBe(403);
  });
});
