/**
 * Semi-monthly payroll settings (Super Admin): the monthly withholding tax
 * table and per-employee contribution amounts, both saved as versions from an
 * effective date (src/app/api/admin/payroll-settings/route.js).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;

const SUPER = { userId: "u-sa", role: "super_admin", branchId: null, fullName: "Sam Super" };
const ACCOUNTANT = { userId: "u-acct", role: "accountant", branchId: "branch-a", fullName: "Ana Accountant" };

function requestAs({ userId, role, branchId, fullName }, method = "GET", body) {
  const token = createSessionToken({
    user_id: userId, role, branch_id: branchId, email: `${userId}@sacs.test`, full_name: fullName, session_id: "s-1",
  });
  return new Request("https://sacs.test/api/admin/payroll-settings", {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-payroll-settings";
  resetDb();
  users.push({ id: "u-emp", email: "emp@sacs.test", user_metadata: { role: "employee", full_name: "Emma Employee", employee_id: "SACS-001", basic_salary: 32000, branch_id: "branch-a" } });
  table("profiles").push(
    { id: "u-sa", role: "super_admin" },
    { id: "u-emp", full_name: "Emma Employee", branch_id: "branch-a", role: "employee", basic_salary: 32000, employee_id: "SACS-001", archived: false },
  );
  table("payroll_tax_brackets").push(
    { id: "t0", version_id: "bir", effective_date: "2023-01-01", bracket_over: 0, base_tax: 0, rate_pct: 0, created_at: "2023-01-01" },
    { id: "t1", version_id: "bir", effective_date: "2023-01-01", bracket_over: 20833, base_tax: 0, rate_pct: 15, created_at: "2023-01-01" },
  );
  ({ GET, POST } = await import("@/app/api/admin/payroll-settings/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

describe("payroll settings", () => {
  it("lists the tax table in force and each employee's computed contributions", async () => {
    const body = await (await GET(requestAs(SUPER))).json();
    expect(body.available).toBe(true);
    expect(body.tax_table.versions[0].rows).toEqual([
      { bracket_over: 0, base_tax: 0, rate_pct: 0 },
      { bracket_over: 20833, base_tax: 0, rate_pct: 15 },
    ]);
    expect(body.contributions).toEqual([expect.objectContaining({ employee_id: "u-emp", monthly_salary: 32000, fixed: null })]);
  });

  it("shows the default payroll actually deducts: the school's fixed amounts when that switch is on", async () => {
    const rate = (rateType, value) => ({
      id: `cfg-${rateType}`, rate_type: rateType, scope: "global", scope_ref: null, value,
      effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z",
    });
    table("payroll_rate_configs").push(
      rate("contribution_method", 1), rate("sss_fixed", 400), rate("philhealth_fixed", 0), rate("pagibig_fixed", 200),
    );
    const body = await (await GET(requestAs(SUPER))).json();
    expect(body.contributions[0]).toMatchObject({
      default_source: "fixed",
      computed: { sss: 400, philhealth: 0, pagibig: 200 },
    });
  });

  it("saves a new tax table version and refuses an invalid one", async () => {
    const bad = await POST(requestAs(SUPER, "POST", { kind: "tax_table", effective_date: "2026-11-01", rows: [{ bracket_over: 100, base_tax: 0, rate_pct: 10 }] }));
    expect(bad.status).toBe(400);
    const good = await POST(requestAs(SUPER, "POST", {
      kind: "tax_table", effective_date: "2026-11-01",
      rows: [{ bracket_over: 0, base_tax: 0, rate_pct: 0 }, { bracket_over: 20833, base_tax: 0, rate_pct: 20 }],
    }));
    expect(good.status).toBe(200);
    expect(table("payroll_tax_brackets").filter((r) => r.effective_date === "2026-11-01")).toHaveLength(2);
  });

  it("moves a change inside a processed period to the next one", async () => {
    table("payroll_entries").push({ employee_id: "u-emp", pay_period: "October 16-31, 2026", status: "paid" });
    const response = await POST(requestAs(SUPER, "POST", { kind: "contribution", employee_id: "u-emp", effective_date: "2026-10-01", sss: 900, philhealth: 200, pagibig: 100 }));
    const body = await response.json();
    expect(body).toMatchObject({ effective_date: "2026-11-01", adjusted: true });
    expect(table("payroll_contribution_amounts")[0]).toMatchObject({ employee_id: "u-emp", sss: 900, philhealth: 200, pagibig: 100 });
  });

  it("is Super Admin only", async () => {
    expect((await GET(requestAs(ACCOUNTANT))).status).toBe(403);
  });
});
