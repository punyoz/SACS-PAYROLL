/**
 * Rule check (2026-10-27): the Accountant only reaches its own branch's
 * payroll — by direct API call too, whatever branch or employee id the
 * request names. An Accountant of Main tries every payroll path on an
 * employee of North.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MAIN = "00000000-0000-4000-8000-00000000b001";
const NORTH = "00000000-0000-4000-8000-00000000b002";
const ANA = "00000000-0000-4000-8000-0000000000e1"; // Main
const NIK = "00000000-0000-4000-8000-0000000000e2"; // North
const PERIOD = "November 1-15, 2026";
const rate = (rateType, value, effectiveDate = "2026-10-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

let createSessionToken;
let SESSION_COOKIE;
const ACCOUNTANT = { user_id: "00000000-0000-4000-8000-0000000000a9", role: "accountant", branch_id: MAIN, full_name: "Main Accountant" };
const request = (url, method = "GET", body) => new Request(`https://sacs.test${url}`, {
  method,
  headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: "s-acct", email: "acct@sacs.test", ...ACCOUNTANT })}` },
  body: body ? JSON.stringify(body) : undefined,
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-accountant-branch";
  resetDb();
  table("branches").push({ id: MAIN, name: "Main" }, { id: NORTH, name: "North" });
  [[ANA, "Ana Main", "SACS-501", MAIN], [NIK, "Nik North", "SACS-502", NORTH]].forEach(([id, name, code, branch]) => {
    users.push({ id, email: `${code}@sacs.test`, user_metadata: { role: "employee", full_name: name, employee_id: code, basic_salary: 15000, branch_id: branch } });
    table("profiles").push({ id, full_name: name, email: `${code}@sacs.test`, branch_id: branch, role: "employee", employee_id: code, archived: false, basic_salary: 15000, date_hired: "2024-06-01" });
  });
  table("profiles").push({ id: ACCOUNTANT.user_id, role: "accountant", branch_id: MAIN, full_name: "Main Accountant", archived: false });
  table("payroll_rate_configs").push(
    rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("contribution_method", 0),
    rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2), rate("sss_msc_min", 5000), rate("sss_msc_max", 35000),
    rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
  );
  table("payroll_tax_brackets").push({ id: "bir-0", version_id: "bir", effective_date: "2023-01-01", bracket_over: 0, base_tax: 0, rate_pct: 0, created_at: "2023-01-01T00:00:00Z" });
  // North's payslip from an earlier run, which Main's Accountant must not see.
  table("payroll_entries").push({ id: "e-north", employee_id: NIK, employee_name: "Nik North", branch_id: NORTH, pay_period: "October 1-15, 2026", status: "paid", payroll: { basic_salary: 7500, totals: { net_pay: 7500 } } });
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

describe("an Accountant of Main reaches Main only", () => {
  it("the employee list, the computed rows and the payroll records hold Main only", async () => {
    const { GET } = await import("@/app/api/accountant/payroll/route");
    const body = await (await GET(request(`/api/accountant/payroll?period=${encodeURIComponent(PERIOD)}`))).json();
    expect(body.employees.map((e) => e.id)).toEqual([ANA]);
    expect((body.attendance_rows || []).map((r) => r.employee_id)).toEqual([ANA]);
    expect(JSON.stringify(body)).not.toContain("Nik North");
  });

  it("processing, a draft, the batch and Generate refuse North's employee", async () => {
    const { POST, PATCH } = await import("@/app/api/accountant/payroll/route");
    expect((await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: NIK, pay_period: PERIOD }))).status).toBe(404);
    expect((await POST(request("/api/accountant/payroll", "POST", { action: "save_draft", employee_id: NIK, pay_period: PERIOD }))).status).toBe(404);
    const batch = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: PERIOD, entries: [{ employee_id: NIK }] }))).json();
    expect(batch.processed || []).toHaveLength(0);
    expect((await PATCH(request("/api/accountant/payroll", "PATCH", { action: "generate", employee_id: NIK, pay_period: PERIOD }))).status).toBe(404);
    expect(table("payroll_entries").filter((e) => e.employee_id === NIK)).toHaveLength(1);
  });

  it("the payroll sheet ignores a branch_id naming North", async () => {
    const { GET } = await import("@/app/api/accountant/payroll/route");
    const body = await (await GET(request(`/api/accountant/payroll?view=payroll_sheet&period=${encodeURIComponent("October 1-15, 2026")}&branch_id=${NORTH}`))).json();
    expect(JSON.stringify(body)).not.toContain("Nik North");
  });

  it("incentives, flags, loans and remittance refuse or hide North", async () => {
    const { POST } = await import("@/app/api/accountant/payroll/route");
    expect((await POST(request("/api/accountant/payroll", "POST", { action: "add_monthly_item", employee_id: NIK, kind: "incentive", amount: 500, item_date: "2026-11-10", description: "Coaching" }))).status).toBe(404);
    expect((await POST(request("/api/accountant/payroll", "POST", { action: "flag_deduction", employee_id: NIK, pay_period: PERIOD, field: "sss", note: "Please check this one" }))).status).toBe(404);
    const loans = await import("@/app/api/accountant/loans/route");
    expect((await loans.POST(request("/api/accountant/loans", "POST", { action: "create_loan", employee_id: NIK, loan_type: "salary", principal: 1000, installments: 2, date_granted: "2026-11-10", description: "x" }))).status).toBe(404);
    const remittance = await import("@/app/api/payroll/remittance/route");
    const rem = await (await remittance.GET(request("/api/payroll/remittance?month=2026-10"))).json();
    expect(rem.rows.map((r) => r.employee_id)).not.toContain(NIK);
  });
});
