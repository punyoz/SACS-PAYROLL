/**
 * Nobody processes, adjusts or adds to their own pay: an Accountant is on the
 * payroll they run, so their own payslip, incentives and cash advances are
 * handled by another Accountant of the branch or a Super Admin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const PERIOD = "September 16-30, 2026";

const rate = (rateType, value) => ({
  id: `cfg-${rateType}`, rate_type: rateType, scope: "global", scope_ref: null, value,
  effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z",
});

const ANA = { user_id: "u-ana", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };
const BEN = { user_id: "u-ben", role: "accountant", branch_id: BRANCH, full_name: "Ben Accountant" };
const SUPER = { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" };

let GET;
let POST;
let PATCH;
let createSessionToken;
let SESSION_COOKIE;

function request(who, method, body, query = "") {
  const token = createSessionToken({ ...who, email: `${who.user_id}@sacs.test`, session_id: "s-1" });
  return new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(handler, who, method, body) {
  const response = await handler(request(who, method, body));
  return { response, body: await response.json() };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-own-payroll";
  resetDb();
  [ANA, BEN].forEach((who, i) => users.push({
    id: who.user_id, email: `${who.user_id}@sacs.test`,
    user_metadata: { role: "accountant", full_name: who.full_name, employee_id: `SACS-00${i + 1}`, basic_salary: 20000, branch_id: BRANCH },
  }));
  table("profiles").push(
    { id: ANA.user_id, full_name: ANA.full_name, email: "u-ana@sacs.test", branch_id: BRANCH, role: "accountant", basic_salary: 20000 },
    { id: BEN.user_id, full_name: BEN.full_name, email: "u-ben@sacs.test", branch_id: BRANCH, role: "accountant", basic_salary: 20000 },
  );
  table("branches").push({ id: BRANCH, name: "Main Branch" });
  table("payroll_rate_configs").push(
    rate("hourly", 60), rate("daily", 500), rate("half_day_pct", 50), rate("absent_pct", 100),
    rate("late_days_per_absent", 3), rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0),
    rate("perfect_attendance_bonus", 0), rate("sss_pct", 2), rate("philhealth_pct", 2), rate("pagibig_pct", 2),
  );
  ({ GET, POST, PATCH } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("own payroll", () => {
  it("an Accountant cannot generate their own payslip; a colleague and a Super Admin can", async () => {
    const own = await call(PATCH, ANA, "PATCH", { action: "generate", employee_id: ANA.user_id, pay_period: PERIOD });
    expect(own.response.status).toBe(403);
    expect(own.body.code).toBe("own_payroll");
    expect(table("payroll_entries")).toHaveLength(0);

    const colleague = await call(PATCH, BEN, "PATCH", { action: "generate", employee_id: ANA.user_id, pay_period: PERIOD });
    expect(colleague.response.status).toBe(200);

    const superAdmin = await call(PATCH, SUPER, "PATCH", { action: "generate", employee_id: BEN.user_id, pay_period: PERIOD });
    expect(superAdmin.response.status).toBe(200);
  });

  it("an Accountant cannot save or process their own payroll, or raise their own basic salary", async () => {
    const draft = await call(POST, ANA, "POST", {
      action: "submit", employee_id: ANA.user_id, pay_period: PERIOD, basic_salary: 50000, override_reason: "raise",
    });
    expect(draft.response.status).toBe(403);
    expect(table("payroll_entries")).toHaveLength(0);
  });

  it("the batch skips the Accountant's own row and processes the rest", async () => {
    vi.setSystemTime(new Date("2026-10-02T10:00:00+08:00"));
    const { body } = await call(POST, ANA, "POST", {
      action: "batch_submit", pay_period: PERIOD, entries: [{ employee_id: ANA.user_id }, { employee_id: BEN.user_id }],
    });
    expect(body.skipped).toEqual([expect.objectContaining({ employee_id: ANA.user_id, code: "own_payroll" })]);
    expect(body.processed.map((row) => row.employee_id)).toEqual([BEN.user_id]);
  });

  it("an Accountant cannot give themselves a cash advance or an incentive", async () => {
    const advance = await call(POST, ANA, "POST", {
      action: "add_cash_advance", employee_id: ANA.user_id, principal: 5000, installment_amount: 1000,
      deduct_on: "both", date_granted: "2026-10-01", start_date: "2026-10-16",
    });
    expect(advance.response.status).toBe(403);
    const incentive = await call(POST, ANA, "POST", {
      action: "add_monthly_item", employee_id: ANA.user_id, kind: "incentive", item_date: "2026-10-05", description: "Bonus", amount: 1000,
    });
    expect(incentive.response.status).toBe(403);
    expect(table("payroll_cash_advances")).toHaveLength(0);
    expect(table("payroll_monthly_incentives")).toHaveLength(0);

    const forColleague = await call(POST, ANA, "POST", {
      action: "add_cash_advance", employee_id: BEN.user_id, principal: 5000, installment_amount: 1000,
      deduct_on: "both", date_granted: "2026-10-01", start_date: "2026-10-16",
    });
    expect(forColleague.response.status).toBe(200);
  });

  it("the Accountant still sees their own row in the payroll list", async () => {
    const response = await GET(request(ANA, "GET", null, `?period=${encodeURIComponent(PERIOD)}`));
    const body = await response.json();
    expect(body.employees.map((e) => e.id)).toContain(ANA.user_id);
  });
});

describe("position-scoped rates", () => {
  it("follow profiles.position, not the user_metadata.position the account holder can edit", async () => {
    // Ana edited her own metadata to "Principal"; HR has her as "Staff".
    users[0].user_metadata.position = "Principal";
    table("profiles")[0].position = "Staff";
    table("payroll_rate_configs").push({
      id: "cfg-principal", rate_type: "daily", scope: "position", scope_ref: "Principal", value: 5000,
      effective_date: "2026-01-01", created_at: "2026-01-02T00:00:00Z",
    });
    const response = await GET(request(BEN, "GET", null, `?period=${encodeURIComponent(PERIOD)}`));
    const body = await response.json();
    const ana = body.attendance_rows.find((row) => row.employee_id === ANA.user_id);
    expect(ana.rates.daily).toBe(500);
  });
});
