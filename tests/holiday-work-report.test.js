/**
 * Holiday Work report (GET /api/accountant/payroll?view=holiday_work) and the
 * holiday lines on a payslip: one row per holiday worked, read from the
 * payslip's own computation, only for the caller's branch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };

let GET;
let createSessionToken;
let SESSION_COOKIE;

function request(who, query) {
  const token = createSessionToken({ ...who, email: `${who.user_id}@sacs.test`, session_id: "s-1" });
  return new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

const entry = (id, employeeId, name, period, status, lines) => ({
  id, employee_id: employeeId, employee_name: name, employee_code: `SACS-${id}`, pay_period: period, status,
  payslip_no: status === "paid" ? `PS-${id}` : null, updated_at: "2026-12-01T00:00:00Z",
  payroll: { basic_salary: 10000, totals: { gross_pay: 10000, net_pay: 9000, holiday_pay: lines.reduce((s, l) => s + l.amount, 0) }, audit: { lines: { incentives: lines } } },
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-holiday-work";
  resetDb();
  users.push(
    { id: "u-emp", email: "emp@sacs.test", user_metadata: { role: "employee", full_name: "Emma Employee", employee_id: "SACS-001", branch_id: BRANCH } },
    { id: "u-far", email: "far@sacs.test", user_metadata: { role: "employee", full_name: "Fred Far", employee_id: "SACS-002", branch_id: "branch-b" } },
  );
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH, role: "accountant" },
    { id: "u-emp", full_name: "Emma Employee", email: "emp@sacs.test", branch_id: BRANCH, role: "employee" },
    { id: "u-far", full_name: "Fred Far", email: "far@sacs.test", branch_id: "branch-b", role: "employee" },
  );
  const bonifacio = { type: "holiday_premium", amount: 500, quantity: 1, log_date: "2026-11-30", holiday_type: "holiday", holiday_name: "Bonifacio Day", hours: 8 };
  table("payroll_entries").push(
    entry("1", "u-emp", "Emma Employee", "November 16-30, 2026", "paid", [bonifacio]),
    entry("2", "u-far", "Fred Far", "November 16-30, 2026", "paid", [bonifacio]),
  );
  ({ GET } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Holiday Work report", () => {
  it("lists each holiday worked in the caller's branch, with hours and premium", async () => {
    const response = await GET(request(ACCOUNTANT, "?view=holiday_work&period=all"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rows).toEqual([expect.objectContaining({
      employee_name: "Emma Employee", date: "2026-11-30", holiday: "Bonifacio Day", hours: 8, amount: 500, status: "final", payslip_no: "PS-1",
    })]);
    expect(body.totals).toMatchObject({ employees: 1, days: 1, hours: 8, amount: 500 });
  });

  it("filters by pay period", async () => {
    const body = await (await GET(request(ACCOUNTANT, `?view=holiday_work&period=${encodeURIComponent("December 1-15, 2026")}`))).json();
    expect(body.rows).toEqual([]);
  });

  it("puts the holiday lines on the payslip", async () => {
    const body = await (await GET(request(ACCOUNTANT, "?entry_id=1"))).json();
    expect(body.payslip.holiday_lines).toEqual([{ date: "2026-11-30", name: "Bonifacio Day", type: "holiday", hours: 8, amount: 500 }]);
  });
});
