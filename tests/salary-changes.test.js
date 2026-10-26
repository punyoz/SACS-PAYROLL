/**
 * Basic salary changes (2026-10-26): HR only, from the 1st of a month, with a
 * reason, logged old → new; payroll uses the salary in force on each period's
 * first day, so earlier periods keep the old salary and processed payslips
 * never change. The Accountant can no longer type a basic salary while
 * processing payroll.
 *
 * Ehd Astillero Refuerzo (live, ₱15,000) gets a raise to ₱18,000 from
 * December 1, 2026.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { salaryOn, validateSalaryChange } from "@/lib/employees/salary-history";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const EHD = "7b8837ea-43db-4b30-829a-31b159d08059";
const HR_ID = "00000000-0000-4000-8000-0000000000b1";
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
const rate = (rateType, value, effectiveDate = "2026-10-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

const WHO = {
  hr: { user_id: HR_ID, role: "hr", branch_id: null, full_name: "HR Officer" },
  accountant: { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Payroll JM" },
  super_admin: { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Super Administrator" },
  admin: { user_id: "u-adm", role: "admin", branch_id: BRANCH, full_name: "System Admin" },
  employee: { user_id: EHD, role: "employee", branch_id: BRANCH, full_name: "Ehd Astillero Refuerzo" },
};

let createSessionToken;
let SESSION_COOKIE;
const request = (url, method = "GET", body, who = WHO.hr) => {
  const req = new Request(`https://sacs.test${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: `s-${who.user_id}`, email: `${who.user_id}@sacs.test`, ...who })}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  req.nextUrl = new URL(req.url);
  return req;
};
const RAISE = { employee_id: EHD, new_salary: 18000, effective_date: "2026-12-01", reason: "Performance review", note: "Annual review" };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-salary-changes";
  resetDb();
  users.push({ id: EHD, email: "ehd@sacs.test", user_metadata: { role: "employee", full_name: "Ehd Astillero Refuerzo", employee_id: "SACS-001", basic_salary: 15000, branch_id: BRANCH } });
  table("profiles").push(
    { id: EHD, full_name: "Ehd Astillero Refuerzo", email: "ehd@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-001", archived: false, basic_salary: 15000, date_hired: "2024-06-01" },
    { id: HR_ID, role: "hr", branch_id: null, full_name: "HR Officer", archived: false },
    { id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Payroll JM", archived: false },
  );
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

describe("HR records a raise", () => {
  it("from a future month: saved with who, old → new, month and reason; the salary on record waits", async () => {
    const { POST, GET } = await import("@/app/api/hr/salary-changes/route");
    const res = await POST(request("/api/hr/salary-changes", "POST", RAISE));
    expect(res.status).toBe(200);
    expect(table("employee_salary_changes")[0]).toMatchObject({
      employee_id: EHD, old_salary: 15000, new_salary: 18000, effective_date: "2026-12-01", reason: "Performance review", note: "Annual review",
      created_by: HR_ID, created_by_name: "HR Officer", created_by_role: "hr",
    });
    const [log] = table("audit_logs").filter((a) => a.action === "salary_change");
    expect(log).toMatchObject({ actor_role: "hr", actor_name: "HR Officer" });
    expect(log.description).toBe("Basic salary of Ehd Astillero Refuerzo: ₱15,000.00 → ₱18,000.00 from 2026-12-01 (Performance review: Annual review), by HR Officer.");
    expect(log.metadata).toMatchObject({ old_salary: 15000, new_salary: 18000, effective_date: "2026-12-01", reason: "Performance review" });
    expect(table("profiles").find((p) => p.id === EHD).basic_salary).toBe(15000);
    const body = await (await GET(request(`/api/hr/salary-changes?employee_id=${EHD}`))).json();
    expect(body).toMatchObject({ on_record: 15000, in_force: 15000 });
    expect(body.changes[0]).toMatchObject({ old_salary: 15000, new_salary: 18000, applied: false });
  });

  it("on its month: the salary on record becomes the new one (profile and account)", async () => {
    const { POST } = await import("@/app/api/hr/salary-changes/route");
    vi.setSystemTime(new Date("2026-12-01T08:00:00+08:00"));
    expect((await POST(request("/api/hr/salary-changes", "POST", RAISE))).status).toBe(200);
    expect(table("profiles").find((p) => p.id === EHD).basic_salary).toBe(18000);
    expect(users.find((u) => u.id === EHD).user_metadata.basic_salary).toBe(18000);
    expect(table("employee_salary_changes")[0].applied_at).toBeTruthy();
  });

  it("refuses a date that is not the 1st, a past month, no reason, the same salary, or a month already settled", async () => {
    const { POST } = await import("@/app/api/hr/salary-changes/route");
    const post = (over) => POST(request("/api/hr/salary-changes", "POST", { ...RAISE, ...over }));
    expect((await post({ effective_date: "2026-12-16" })).status).toBe(400);
    expect((await post({ effective_date: "2026-09-01" })).status).toBe(400);
    expect((await post({ reason: "" })).status).toBe(400);
    expect((await post({ reason: "Other", note: "short" })).status).toBe(400);
    expect((await post({ new_salary: 15000 })).status).toBe(400);
    table("payroll_entries").push({ id: "e1", employee_id: EHD, pay_period: "October 16-31, 2026", status: "paid" });
    expect((await post({ effective_date: "2026-10-01" })).status).toBe(400);
    expect(table("employee_salary_changes")).toHaveLength(0);
  });

  it("the general employee update can no longer change a salary", async () => {
    const { PATCH } = await import("@/app/api/admin/employees/route");
    const res = await PATCH(request("/api/admin/employees", "PATCH", { id: EHD, full_name: "Ehd Astillero Refuerzo", basic_salary: 25000 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("salary_change_required");
    expect(table("profiles").find((p) => p.id === EHD).basic_salary).toBe(15000);
  });
});

describe("nobody else can", () => {
  it.each(["accountant", "super_admin", "admin", "employee"])("%s: refused by the route and the proxy, nothing saved", async (role) => {
    const { POST, GET } = await import("@/app/api/hr/salary-changes/route");
    const { proxy } = await import("@/proxy");
    expect((await POST(request("/api/hr/salary-changes", "POST", RAISE, WHO[role]))).status).toBe(403);
    expect((await GET(request(`/api/hr/salary-changes?employee_id=${EHD}`, "GET", null, WHO[role]))).status).toBe(403);
    expect((await proxy(request("/api/hr/salary-changes", "POST", RAISE, WHO[role]))).status).toBe(403);
    expect(table("employee_salary_changes")).toHaveLength(0);
  });

  it("the Accountant cannot change a salary through the employee update either", async () => {
    const { PATCH } = await import("@/app/api/admin/employees/route");
    expect((await PATCH(request("/api/admin/employees", "PATCH", { id: EHD, basic_salary: 25000 }, WHO.accountant))).status).toBe(403);
  });

  it("the database refuses a change not made by an active HR account, and never rewrites one", () => {
    const sql = readFileSync("supabase/migrations/20261027010000_employee_salary_changes.sql", "utf8");
    expect(sql).toMatch(/NEW\.created_by IS NULL OR v_role IS DISTINCT FROM 'hr' OR v_archived/);
    expect(sql).toMatch(/FUNCTION public\.employee_salary_changes_writer_guard\(\)[\s\S]*?SECURITY INVOKER/);
    expect(sql).toContain("CHECK (EXTRACT(DAY FROM effective_date) = 1)");
    expect(sql).toContain("append_only: a salary change is never rewritten");
    expect(sql).toContain("REVOKE ALL ON public.employee_salary_changes FROM anon, authenticated");
  });
});

describe("salary in force by date", () => {
  const rows = [
    { employee_id: "x", old_salary: 15000, new_salary: 18000, effective_date: "2026-12-01", created_at: "2026-10-26" },
    { employee_id: "x", old_salary: 18000, new_salary: 20000, effective_date: "2027-06-01", created_at: "2026-10-27" },
  ];
  it("old before, new from the 1st, the next change after that; no history = the salary on record", () => {
    expect(salaryOn(rows, "x", "2026-11-16", 18000)).toBe(15000);
    expect(salaryOn(rows, "x", "2026-12-01", 0)).toBe(18000);
    expect(salaryOn(rows, "x", "2027-05-16", 0)).toBe(18000);
    expect(salaryOn(rows, "x", "2027-06-01", 0)).toBe(20000);
    expect(salaryOn(rows, "y", "2026-12-01", 12345)).toBe(12345);
  });
  it("validates on its own too", () => {
    expect(validateSalaryChange({ new_salary: 18000, effective_date: "2026-12-01", reason: "Promotion" }, { todayKey: "2026-10-26" })).toBeNull();
    expect(validateSalaryChange({ new_salary: 0, effective_date: "2026-12-01", reason: "Promotion" }, { todayKey: "2026-10-26" })).toMatch(/new monthly salary/);
  });
});

describe("payroll picks the salary in force", () => {
  let POST;
  const pay = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);
  const process = async (label, at) => {
    vi.setSystemTime(new Date(at));
    const body = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: label, entries: [{ employee_id: EHD }] }, WHO.accountant))).json();
    expect(body.processed, label).toHaveLength(1);
  };

  beforeEach(async () => {
    table("payroll_rate_configs").push(
      rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
      rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
      rate("payroll_per_half", 0), rate("contribution_half", 2), rate("contribution_method", 0), rate("benefits_exempt_ceiling", 90000, "2018-01-01"),
      rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2), rate("sss_msc_min", 5000), rate("sss_msc_max", 35000),
      rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
    );
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
      id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
    })));
    table("payroll_sss_msc_brackets").push(...MSC_ROWS);
    // HR records the raise in October, from December 1.
    const salary = await import("@/app/api/hr/salary-changes/route");
    expect((await salary.POST(request("/api/hr/salary-changes", "POST", RAISE))).status).toBe(200);
    ({ POST } = await import("@/app/api/accountant/payroll/route"));
  });

  it("November (before the raise) uses ₱15,000; December (from the raise) uses ₱18,000; November stays as paid", async () => {
    await process("November 1-15, 2026", "2026-11-16T10:00:00+08:00");
    await process("November 16-30, 2026", "2026-12-02T10:00:00+08:00");
    const nov = pay(EHD, "November 16-30, 2026").payroll;
    // 15,000: daily 15,000 × 12 ÷ 261 = 689.66, hourly 86.21; SSS 750, PhilHealth 375, Pag-IBIG 200.
    expect(nov.monthly).toMatchObject({ monthly_salary: 15000, daily_rate: 689.66, hourly_rate: 86.21, sss: 750, philhealth: 375, pagibig: 200 });
    expect(pay(EHD, "November 1-15, 2026").payroll.basic_salary).toBe(7500);
    const novBefore = JSON.stringify([pay(EHD, "November 1-15, 2026"), pay(EHD, "November 16-30, 2026")]);

    await process("December 1-15, 2026", "2026-12-16T10:00:00+08:00");
    await process("December 16-31, 2026", "2027-01-02T10:00:00+08:00");
    expect(pay(EHD, "December 1-15, 2026").payroll.basic_salary).toBe(9000);
    const dec = pay(EHD, "December 16-31, 2026").payroll;
    // 18,000: daily 827.59, hourly 103.45; SSS 900, PhilHealth 450, Pag-IBIG 200; taxable 16,450 → 0.
    expect(dec.monthly).toMatchObject({ monthly_salary: 18000, daily_rate: 827.59, hourly_rate: 103.45, sss: 900, philhealth: 450, pagibig: 200, taxable_income: 16450, withholding_tax: 0 });
    expect(dec.totals.net_pay).toBe(18000 - 1550 - 9000);
    expect(JSON.stringify([pay(EHD, "November 1-15, 2026"), pay(EHD, "November 16-30, 2026")])).toBe(novBefore);
  });

  it("the Accountant cannot type a basic salary while processing (422 salary_locked)", async () => {
    vi.setSystemTime(new Date("2026-11-16T10:00:00+08:00"));
    const res = await POST(request("/api/accountant/payroll", "POST", { action: "submit", employee_id: EHD, pay_period: "November 1-15, 2026", basic_salary: 9000, override_reason: "Raise came early" }, WHO.accountant));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("salary_locked");
    const batch = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: "November 1-15, 2026", entries: [{ employee_id: EHD, basic_salary: 9000 }] }, WHO.accountant))).json();
    expect(batch.skipped).toEqual([expect.objectContaining({ code: "salary_locked" })]);
  });
});
