/**
 * Decisions of 2026-11-08 (on the Super Admin backup / rates batch):
 *   7  final pay takes its daily rate by the same rule as regular payroll,
 *      a daily rate set for one employee included; a saved final pay is
 *      never recomputed
 *   8  profiles.is_demo: default false, the migration flags no existing row,
 *      only the demo seed sets it; exports and reports skip demo people
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { resolveRates } from "@/lib/payroll/rates";
import { finalPayDailyRate } from "@/lib/payroll/final-pay";
import { loadDemoIds, notDemo } from "@/lib/demo";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const CONFIGS = [
  { id: "w", rate_type: "working_days_per_year", scope: "global", scope_ref: null, value: 261, effective_date: "2026-10-01", created_at: "2026-10-01" },
  { id: "g", rate_type: "daily", scope: "global", scope_ref: null, value: 600, effective_date: "2026-10-01", created_at: "2026-10-01" },
  { id: "b", rate_type: "daily", scope: "branch", scope_ref: "branch-a", value: 525, effective_date: "2026-10-01", created_at: "2026-10-01" },
  { id: "e", rate_type: "daily", scope: "employee", scope_ref: "emp-own", value: 1500, effective_date: "2026-11-01", created_at: "2026-11-01" },
];
const SEPARATED_ON = "2026-12-07";

describe("Final pay daily rate = regular payroll's rule (decision 7)", () => {
  it("salary on file: monthly × 12 ÷ working days per year (unchanged)", () => {
    const rates = resolveRates(CONFIGS, { employeeId: "emp-1", branchId: "branch-a", monthlySalary: 30000 }, SEPARATED_ON);
    expect(finalPayDailyRate(rates)).toBe(1379.31);
  });

  it("a daily rate set for that one employee wins, as in regular payroll", () => {
    const rates = resolveRates(CONFIGS, { employeeId: "emp-own", branchId: "branch-a", monthlySalary: 30000 }, SEPARATED_ON);
    expect(finalPayDailyRate(rates)).toBe(1500);
    // Before the change final pay ignored it: dailyRateFor(30000, 261) = 1379.31.
  });

  it("no salary on file: the branch's daily rate, then the system default (was 0)", () => {
    expect(finalPayDailyRate(resolveRates(CONFIGS, { employeeId: "emp-2", branchId: "branch-a", monthlySalary: 0 }, SEPARATED_ON))).toBe(525);
    expect(finalPayDailyRate(resolveRates(CONFIGS, { employeeId: "emp-3", branchId: "branch-b", monthlySalary: 0 }, SEPARATED_ON))).toBe(600);
  });

  it("takes a plain { daily } value too", () => {
    expect(finalPayDailyRate({ daily: 611.005 })).toBe(611.01);
    expect(finalPayDailyRate({})).toBe(0);
  });
});

describe("A final pay already saved is never recomputed", () => {
  let createSessionToken;
  let SESSION_COOKIE;
  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-decisions-2026-11-08";
    resetDb();
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("POST refuses a second final pay (409) and writes nothing", async () => {
    users.push({ id: "emp-own", email: "own@sacs.test", user_metadata: { role: "employee", full_name: "Own Rate" } });
    table("profiles").push(
      { id: "emp-own", full_name: "Own Rate", email: "own@sacs.test", branch_id: "branch-a", employee_status: "Separated", separated_on: SEPARATED_ON, archived: false, role: "employee" },
      { id: "u-ac", full_name: "Paula Accountant", email: "ac@sacs.test", branch_id: "branch-a", employee_status: "Active", archived: false, role: "accountant" },
    );
    const saved = { id: "fp-1", employee_id: "emp-own", pay_period: "Final pay — separated 2026-12-07", status: "paid", payroll: { totals: { net_pay: 12345.67 } } };
    table("payroll_entries").push(saved);
    const token = createSessionToken({ user_id: "u-ac", role: "accountant", branch_id: "branch-a", email: "ac@sacs.test", full_name: "Paula Accountant", session_id: "s-1" });
    const { POST } = await import("@/app/api/accountant/final-pay/route");
    const response = await POST(new Request("https://sacs.test/api/accountant/final-pay", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ employee_id: "emp-own", release_on: "2026-12-10" }),
    }));
    expect(response.status).toBe(409);
    expect(table("payroll_entries")).toEqual([saved]);
  });
});

describe("Demo data flag (decision 8)", () => {
  it("the migration adds is_demo default false and flags no existing row", () => {
    const sql = readFileSync("supabase/migrations/20261108040000_is_demo_flag.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(sql).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(sql).not.toMatch(/SET\s+is_demo\s*=\s*TRUE/i);
  });

  it("only the demo seed sets it", () => {
    const seed = readFileSync("e2e/scale/demo-60.sql", "utf8");
    expect(seed).toMatch(/is_demo/);
    for (const other of ["e2e/fixtures.sql", "e2e/scale/seed-scale.sql"]) {
      expect(readFileSync(other, "utf8"), other).not.toMatch(/is_demo/);
    }
  });

  it("notDemo keeps real rows and drops a demo person's", () => {
    const demo = new Set(["d1"]);
    const rows = [{ employee_id: "d1" }, { employee_id: "r1" }, { employee_id: null }];
    expect(rows.filter(notDemo(demo))).toEqual([{ employee_id: "r1" }, { employee_id: null }]);
    expect([{ id: "d1" }, { id: "r2" }].filter(notDemo(demo, (r) => r.id))).toEqual([{ id: "r2" }]);
    expect(rows.filter(notDemo(new Set()))).toHaveLength(3);
  });

  it("loadDemoIds reads profiles.is_demo, and is empty when the column is missing", async () => {
    resetDb();
    table("profiles").push({ id: "d1", is_demo: true }, { id: "r1", is_demo: false });
    const { getServiceClient } = await import("@/lib/supabase/admin");
    expect([...(await loadDemoIds(getServiceClient()))]).toEqual(["d1"]);
    const broken = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "column profiles.is_demo does not exist" } }) }) }) }) };
    expect((await loadDemoIds(broken)).size).toBe(0);
  });
});
