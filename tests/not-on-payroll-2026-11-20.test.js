/**
 * "Not on payroll" system accounts (20261120020000): the payroll roster and the
 * employee lists leave them out; the nightly close and the AWOL job skip them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MAIN = "00000000-0000-4000-8000-00000000b001";
const PAID = "00000000-0000-4000-8000-0000000000e1";
const SYSTEM = "00000000-0000-4000-8000-0000000000e2";

beforeEach(() => {
  vi.resetModules();
  resetDb();
  users.push(
    { id: PAID, email: "paid@sacs.test", user_metadata: { role: "hr", full_name: "Paid HR", branch_id: MAIN } },
    { id: SYSTEM, email: "system@sacs.test", user_metadata: { role: "hr", full_name: "System HR", branch_id: MAIN, on_payroll: false } },
  );
  table("profiles").push(
    { id: PAID, full_name: "Paid HR", branch_id: MAIN, role: "hr", archived: false, employee_status: "Active", on_payroll: true },
    { id: SYSTEM, full_name: "System HR", branch_id: MAIN, role: "hr", archived: false, employee_status: "Active", on_payroll: false },
  );
});

describe("not on payroll", () => {
  it("isOnPayroll: only an explicit false takes an account off payroll", async () => {
    const { isOnPayroll } = await import("@/lib/payroll/on-payroll");
    expect(isOnPayroll({ user_metadata: { on_payroll: false } })).toBe(false);
    expect(isOnPayroll({ user_metadata: {} })).toBe(true);
    expect(isOnPayroll({})).toBe(true);
  });

  it("the payroll roster leaves the system account out", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { invalidateUsersCache } = await import("@/lib/auth/users-cache");
    invalidateUsersCache();
    const { loadPayrollStaff } = await import("@/lib/payroll/staff");
    const staff = await loadPayrollStaff(createClient("https://x.supabase.co", "k"), { branchExempt: true });
    expect(staff.map((p) => p.id)).toEqual([PAID]);
  });

  it("the nightly close and the AWOL job skip it (migration)", () => {
    const sql = readFileSync("supabase/migrations/20261120020000_not_on_payroll.sql", "utf8");
    expect(sql).toMatch(/attendance_missing_days[\s\S]*AND pr\.on_payroll/);
    expect(sql).toMatch(/awol_flag_candidates[\s\S]*AND p\.on_payroll/);
  });
});
