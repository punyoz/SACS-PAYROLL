/**
 * HR → Payroll Records (/api/hr/payroll-records): every branch's processed
 * payslips, read-only. Drafts are not listed; Admin and Accountant see their
 * own branch (as the matrix gives them); the Employee is refused; the proxy
 * maps the route to payroll_records.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MAIN = "b-main";
const OTHER = "b-other";

const who = {
  hr: { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Rita HR" },
  admin: { user_id: "u-adm", role: "admin", branch_id: MAIN, full_name: "Ada Admin" },
  accountant: { user_id: "u-acct", role: "accountant", branch_id: MAIN, full_name: "Ana Accountant" },
  employee: { user_id: "u-paolo", role: "employee", branch_id: MAIN, full_name: "Paolo Diaz" },
};

const payroll = (gross, deductions) => ({
  basic_salary: gross,
  allowances: {},
  deductions: { sss: 400, philhealth: 0, pagibig: 200, withholding_tax: 0, absences_days: 0 },
  totals: { gross_pay: gross, total_deductions: deductions, net_pay: gross - deductions, absence_deduction: 0 },
  incentives: {},
});

let createSessionToken;
let SESSION_COOKIE;

function get(query, as) {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: "s-1" });
  return import("@/app/api/hr/payroll-records/route").then(({ GET }) => GET(new Request(`https://sacs.test/api/hr/payroll-records${query}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })));
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-hr-payroll-records";
  resetDb();
  const emp = (id, name, code, branch) => ({ id, email: `${id}@sacs.test`, user_metadata: { role: "employee", full_name: name, employee_id: code, branch_id: branch } });
  users.push(emp("u-paolo", "Paolo Diaz", "SACS-010", MAIN), emp("u-far", "Far Away", "SACS-011", OTHER));
  table("branches").push({ id: MAIN, name: "Pasig" }, { id: OTHER, name: "Antipolo" });
  table("profiles").push(
    { id: "u-paolo", full_name: "Paolo Diaz", branch_id: MAIN, employee_status: "Active", employee_type: "Teaching" },
    { id: "u-far", full_name: "Far Away", branch_id: OTHER, employee_status: "Active", employee_type: "Teaching" },
    { id: "u-hr", role: "hr", branch_id: null, archived: false },
    { id: "u-adm", role: "admin", branch_id: MAIN, archived: false },
    { id: "u-acct", role: "accountant", branch_id: MAIN, archived: false },
  );
  table("payroll_runs").push({ id: "run-1", status: "approved", branch_id: MAIN, period_label: "October 1-15, 2026", period_start: "2026-10-01" });
  // payroll_entries.branch_id is stamped by the database (payroll_entries_stamp_branch).
  table("payroll_entries").push(
    { id: "e-paolo", branch_id: MAIN, employee_id: "u-paolo", employee_name: "Paolo Diaz", employee_code: "SACS-010", employee_type: "Teaching", pay_period: "October 1-15, 2026", status: "final", payslip_no: "PS-0001", run_id: "run-1", payroll: payroll(10000, 600), submitted_at: "2026-10-15T08:00:00Z", updated_at: "2026-10-15T08:00:00Z" },
    { id: "e-far", branch_id: OTHER, employee_id: "u-far", employee_name: "Far Away", employee_code: "SACS-011", employee_type: "Teaching", pay_period: "October 1-15, 2026", status: "final", payslip_no: "PS-0002", payroll: payroll(12000, 600), submitted_at: "2026-10-15T08:00:00Z", updated_at: "2026-10-15T08:00:00Z" },
    { id: "e-draft", branch_id: MAIN, employee_id: "u-paolo", employee_name: "Paolo Diaz", pay_period: "October 16-31, 2026", status: "draft", payroll: payroll(10000, 0), updated_at: "2026-10-16T08:00:00Z" },
  );
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("HR payroll records", () => {
  it("lists every branch's processed payslips for HR, without drafts", async () => {
    const response = await get("", who.hr);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.records.map((r) => r.id).sort()).toEqual(["e-far", "e-paolo"]);
    expect(body.records.find((r) => r.id === "e-paolo")).toMatchObject({
      branch_name: "Pasig", gross_pay: 10000, total_deductions: 600, net_pay: 9400, payslip_no: "PS-0001", run_status: "approved",
    });
    expect(body.periods).toEqual(["October 1-15, 2026"]);
  });

  it("opens one payslip and its PDF", async () => {
    const one = await (await get("?entry_id=e-far", who.hr)).json();
    expect(one.payslip).toMatchObject({ entry_id: "e-far", payslip_no: "PS-0002", net_pay: 11400, status: "final" });
    const pdf = await get("?entry_id=e-far&format=pdf", who.hr);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect((await get("?entry_id=e-draft", who.hr)).status).toBe(404);
  });

  it("keeps the Accountant to its own branch, and refuses the Admin (2026-10-20)", async () => {
    const body = await (await get("", who.accountant)).json();
    expect(body.records.map((r) => r.id)).toEqual(["e-paolo"]);
    expect((await get("?entry_id=e-far", who.accountant)).status).toBe(404);
    expect((await get("", who.admin)).status).toBe(403);
  });

  it("refuses the Employee (own payslips only, on its own page)", async () => {
    expect((await get("", who.employee)).status).toBe(403);
    expect((await get("?entry_id=e-paolo", who.employee)).status).toBe(403);
  });

  it("is guarded by payroll_records in the proxy, and has no write method", async () => {
    const { proxy } = await import("@/proxy");
    const as = (role) => {
      const token = createSessionToken({ ...who[role], email: `${who[role].user_id}@sacs.test`, session_id: "s-1" });
      return new NextRequest("https://sacs.test/api/hr/payroll-records", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    };
    users.find((u) => u.id === "u-paolo").app_metadata = { session_id: "s-1" };
    users.push({ id: "u-hr", email: "u-hr@sacs.test", app_metadata: { session_id: "s-1" }, user_metadata: { role: "hr" } });
    expect((await proxy(as("hr"))).status).toBe(200);
    expect((await proxy(as("employee"))).status).toBe(403);
    const route = await import("@/app/api/hr/payroll-records/route");
    expect(route.POST || route.PATCH || route.PUT || route.DELETE).toBeUndefined();
  });
});
