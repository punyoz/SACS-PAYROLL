/**
 * Who may see and change the government deduction tables (2026-10-26):
 * Super Admin edits; Accountant and HR read; Admin and Employee nothing.
 * Every check below goes through the server (route handler or proxy), never
 * the screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table } from "./helpers/fake-supabase.js";
import { can } from "@/lib/rbac/permissions";
import { allowedPagesFor, buildMenu } from "@/lib/rbac/menu";
import { resolveRates, rateValues, validateRateInput } from "@/lib/payroll/rates";
import { monthlyContributions } from "@/lib/payroll/statutory";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

let createSessionToken;
let SESSION_COOKIE;

const PEOPLE = {
  super_admin: { userId: "u-sa", role: "super_admin", branchId: null, fullName: "Sam Super" },
  accountant: { userId: "u-acct", role: "accountant", branchId: "branch-a", fullName: "Acel Accountant" },
  hr: { userId: "u-hr", role: "hr", branchId: null, fullName: "Hana HR" },
  admin: { userId: "u-adm", role: "admin", branchId: "branch-a", fullName: "Ada Admin" },
  employee: { userId: "u-emp", role: "employee", branchId: "branch-a", fullName: "Ella Employee" },
};

function requestAs({ userId, role, branchId, fullName }, url, method = "GET", body) {
  const token = createSessionToken({ user_id: userId, role, branch_id: branchId, email: `${userId}@sacs.test`, full_name: fullName, session_id: `s-${userId}` });
  const request = new Request(`https://sacs.test${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  request.nextUrl = new URL(request.url);
  return request;
}

const rate = (rateType, value, effectiveDate = "2026-10-01", createdAt = `${effectiveDate}T00:00:00Z`) => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate,
  created_at: createdAt, created_by_name: "Sam Super", note: null,
});
const BIR = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const TAX = [
  [0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35],
].map(([over, base, pct]) => ({ bracket_over: over, base_tax: base, rate_pct: pct }));
const MSC = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-government-rates";
  resetDb();
  Object.values(PEOPLE).forEach((p) => table("profiles").push({ id: p.userId, role: p.role, branch_id: p.branchId, full_name: p.fullName, archived: false }));
  table("payroll_rate_configs").push(
    rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2),
    rate("sss_msc_min", 5000), rate("sss_msc_max", 35000), rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
    rate("daily", 600),
  );
  table("payroll_tax_brackets").push(...BIR.map(([over, base, pct]) => ({
    id: `bir-${over}`, version_id: "bir-2023", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, note: "BIR 2023", created_by_name: "System default", created_at: "2023-01-01T00:00:00Z",
  })));
  table("payroll_sss_msc_brackets").push(...MSC.map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_by_name: "System default", created_at: "2025-01-01T00:00:00Z" })));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

describe("the permission matrix", () => {
  it("Super Admin creates and reads; HR adds versions too (Part E); Accountant only reads; Admin and Employee nothing", () => {
    const matrix = Object.fromEntries(Object.keys(PEOPLE).map((role) => [role, ["create", "read", "update", "delete"].filter((action) => can(role, "government_rates", action))]));
    expect(matrix).toEqual({ super_admin: ["create", "read", "update"], accountant: ["read"], hr: ["create", "read"], admin: [], employee: [] });
  });

  it("the page is in the Accountant and HR sidebars only, never the Employee's", () => {
    expect(allowedPagesFor("accountant")).toContain("ac-gov-rates");
    expect(allowedPagesFor("hr")).toContain("hr-gov-rates");
    for (const role of ["employee", "admin"]) {
      expect(buildMenu(role).flatMap((s) => s.items).some((item) => item.module === "government_rates"), role).toBe(false);
    }
  });
});

describe("GET /api/payroll/government-rates (read-only view)", () => {
  const get = async (who) => {
    const { GET } = await import("@/app/api/payroll/government-rates/route");
    const response = await GET(requestAs(who, "/api/payroll/government-rates"));
    return { status: response.status, body: await response.json() };
  };

  it.each(["super_admin", "accountant", "hr"])("%s sees the tables, current and history, and nothing per employee", async (role) => {
    const { status, body } = await get(PEOPLE[role]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, can_edit: false });
    expect(body.rates.find((r) => r.rate_type === "sss_pct")).toMatchObject({ current: 5, next_period: 5 });
    expect(body.rates.map((r) => r.rate_type)).not.toContain("daily");
    expect(body.tax_table.versions[0].rows).toHaveLength(6);
    expect(body.sss_msc.versions[0].rows).toHaveLength(61);
    expect(JSON.stringify(body)).not.toMatch(/"(basic_salary|monthly_salary|employee_id|employee_name|contributions)"/);
    expect(body).not.toHaveProperty("contributions");
  });

  it.each(["admin", "employee"])("%s is refused (403)", async (role) => {
    expect((await get(PEOPLE[role])).status).toBe(403);
  });

  it("the route has no write for anyone (405), and the proxy refuses a write from a reader first (403)", async () => {
    const route = await import("@/app/api/payroll/government-rates/route");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await route[method](requestAs(PEOPLE.super_admin, "/api/payroll/government-rates", method, {}))).status, method).toBe(405);
    }
    const { proxy } = await import("@/proxy");
    expect((await proxy(requestAs(PEOPLE.accountant, "/api/payroll/government-rates", "POST", { sss_pct: 1 }))).status).toBe(403);
    expect((await proxy(requestAs(PEOPLE.hr, "/api/payroll/government-rates", "PATCH", { sss_pct: 1 }))).status).toBe(403);
    expect((await proxy(requestAs(PEOPLE.employee, "/api/payroll/government-rates"))).status).toBe(403);
  });
});

describe("edit routes: only the Super Admin", () => {
  const ratesRoute = () => import("@/app/api/admin/payroll-rates/route");
  const settingsRoute = () => import("@/app/api/admin/payroll-settings/route");
  const WRITES = [
    ["/api/admin/payroll-rates", ratesRoute, { rate_type: "sss_pct", scope: "global", value: 4.5, effective_date: "2026-12-01" }],
    ["/api/admin/payroll-rates", ratesRoute, { rate_type: "pagibig_max_salary", scope: "global", value: 20000, effective_date: "2026-12-01" }],
    ["/api/admin/payroll-settings", settingsRoute, { kind: "tax_table", effective_date: "2026-12-01", rows: TAX }],
    ["/api/admin/payroll-settings", settingsRoute, { kind: "sss_msc_table", effective_date: "2026-12-01", rows: MSC }],
  ];

  it.each(["accountant", "hr", "admin", "employee"])("%s: every write is refused by the handler and by the proxy, and nothing is saved", async (role) => {
    const { proxy } = await import("@/proxy");
    const before = [table("payroll_rate_configs").length, table("payroll_tax_brackets").length, table("payroll_sss_msc_brackets").length];
    for (const [url, load, body] of WRITES) {
      const { POST } = await load();
      expect((await POST(requestAs(PEOPLE[role], url, "POST", body))).status, `${role} ${url} ${body.kind || body.rate_type}`).toBe(403);
      expect((await proxy(requestAs(PEOPLE[role], url, "POST", body))).status, `proxy ${role} ${url}`).toBe(403);
    }
    // The Super Admin's settings screen (with salaries) is not readable either.
    expect((await (await settingsRoute()).GET(requestAs(PEOPLE[role], "/api/admin/payroll-settings"))).status).toBe(403);
    expect((await (await ratesRoute()).GET(requestAs(PEOPLE[role], "/api/admin/payroll-rates"))).status).toBe(403);
    expect([table("payroll_rate_configs").length, table("payroll_tax_brackets").length, table("payroll_sss_msc_brackets").length]).toEqual(before);
    expect(table("audit_logs")).toHaveLength(0);
  });

  it("Super Admin: a rate change is saved and logged with who, when and old → new", async () => {
    const { POST } = await ratesRoute();
    const response = await POST(requestAs(PEOPLE.super_admin, "/api/admin/payroll-rates", "POST", { rate_type: "sss_pct", scope: "global", value: 4.5, effective_date: "2026-12-01", note: "SSS circular" }));
    expect(response.status).toBe(200);
    expect(table("payroll_rate_configs").at(-1)).toMatchObject({ rate_type: "sss_pct", value: 4.5, effective_date: "2026-12-01", created_by: "u-sa", created_by_name: "Sam Super" });
    const [entry] = table("audit_logs");
    expect(entry).toMatchObject({ action: "rate_version", actor_role: "super_admin", actor_name: "Sam Super" });
    expect(entry.description).toBe("SSS contribution: 5 → 4.5 from 2026-12-01 by Sam Super. Reason: SSS circular.");
    expect(entry.metadata).toMatchObject({ rate_type: "sss_pct", previous_value: 5, value: 4.5, effective_date: "2026-12-01", government: true });
    expect(entry.created_at || entry.timestamp).toBeTruthy();
  });

  it("the tax table is locked for everyone, the Super Admin included (decision 2026-11-09 #3)", async () => {
    const { POST } = await settingsRoute();
    const rows = TAX.map((row) => (row.bracket_over === 20833 ? { ...row, rate_pct: 18 } : row));
    const res = await POST(requestAs(PEOPLE.super_admin, "/api/admin/payroll-settings", "POST", { kind: "tax_table", effective_date: "2027-01-01", rows, note: "BIR" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("tax_table_locked");
    expect(table("payroll_tax_brackets")).toHaveLength(6);
  });

  it("Super Admin: an SSS table change logs the brackets that moved", async () => {
    const { POST } = await settingsRoute();
    const rows = [...MSC, { salary_from: 35250, msc: 35500 }];
    expect((await POST(requestAs(PEOPLE.super_admin, "/api/admin/payroll-settings", "POST", { kind: "sss_msc_table", effective_date: "2027-01-01", rows, note: "SSS Circular 2026-1" }))).status).toBe(200);
    const [entry] = table("audit_logs");
    expect(entry.description).toContain("SSS salary credit table: 61 brackets (version of 2025-01-01) → 62 brackets, ₱5000–₱35500, from 2027-01-01");
    expect(entry.description).toContain("Changed: from ₱35250: none → ₱35500.");
  });

  it("refuses values that are not sensible", async () => {
    const { POST } = await ratesRoute();
    const post = (body) => POST(requestAs(PEOPLE.super_admin, "/api/admin/payroll-rates", "POST", { scope: "global", effective_date: "2026-12-01", ...body }));
    expect((await post({ rate_type: "sss_pct", value: 45 })).status).toBe(400);
    expect((await post({ rate_type: "philhealth_floor", value: 150000 })).status).toBe(400);
    expect((await post({ rate_type: "sss_msc_max", value: 4000 })).status).toBe(400);
    expect(validateRateInput({ rate_type: "pagibig_pct", scope: "global", value: 25, effective_date: "2026-12-01" })).toMatch(/not a government contribution rate/);
    const settings = await settingsRoute();
    const bad = (rows) => settings.POST(requestAs(PEOPLE.super_admin, "/api/admin/payroll-settings", "POST", { kind: "tax_table", effective_date: "2026-12-01", rows }));
    // The tax table is locked whatever the rows (decision 2026-11-09 #3).
    expect((await bad([{ bracket_over: 0, base_tax: 0, rate_pct: 120 }])).status).toBe(403);
    expect(table("payroll_rate_configs")).toHaveLength(9);
    expect(table("payroll_tax_brackets")).toHaveLength(6);
  });
});

describe("HR changes government rates and the daily rate (alpha test Part E)", () => {
  const hrRoute = () => import("@/app/api/payroll/rates/route");
  // The bell only takes real ids (UUIDs).
  const SA1 = "00000000-0000-4000-8000-0000000000a1";
  const SA2 = "00000000-0000-4000-8000-0000000000a2";
  const saved = () => table("payroll_rate_configs").filter((r) => String(r.created_by || "").startsWith("u-"));
  const post = async (who, body) => (await hrRoute()).POST(requestAs(PEOPLE[who], "/api/payroll/rates", "POST", { scope: "global", effective_date: "2026-12-01", note: "Circular 2026-9", ...body }));
  beforeEach(() => {
    table("profiles").push(
      { id: SA1, role: "super_admin", full_name: "Sam Super", archived: false },
      { id: SA2, role: "super_admin", full_name: "Sol Super", archived: false },
      { id: "u-hr", role: "hr", full_name: "Hana HR", archived: false },
      { id: "u-hr2", role: "hr", full_name: "Hugo HR", archived: false },
    );
  });

  it("HR adds a new SSS rate version and a daily rate version; old → new is logged and the Super Admin is notified (no amounts)", async () => {
    const response = await post("hr", { rate_type: "sss_pct", value: 4.5 });
    expect(response.status).toBe(200);
    expect(table("payroll_rate_configs").at(-1)).toMatchObject({ rate_type: "sss_pct", value: 4.5, effective_date: "2026-12-01", created_by: "u-hr", note: "Circular 2026-9" });
    const daily = await post("hr", { rate_type: "daily", value: 720 });
    expect(daily.status).toBe(200);
    expect((await daily.json()).hourly_rate).toBe(90);
    const logs = table("audit_logs").filter((l) => l.action === "rate_version");
    expect(logs[0].metadata).toMatchObject({ rate_type: "sss_pct", previous_value: 5, value: 4.5, reason: "Circular 2026-9", changed_by_role: "hr" });
    const notes = table("notifications");
    expect(notes.map((n) => n.recipient_id).sort()).toEqual([SA1, SA1, SA2, SA2]);
    expect(notes[0]).toMatchObject({ kind: "rate_change", link_page: "sa-config" });
    expect(notes.map((n) => `${n.title} ${n.body}`).join(" ")).not.toMatch(/720|4\.5|₱/);
  });

  it("HR cannot type the hourly rate, change other payroll rules, or skip the reason or the date", async () => {
    expect((await post("hr", { rate_type: "hourly", value: 90 })).status).toBe(400);
    expect((await post("hr", { rate_type: "overtime_premium_pct", value: 30 })).status).toBe(403);
    expect((await post("hr", { rate_type: "sss_pct", value: 4.5, note: "" })).status).toBe(400);
    expect((await post("hr", { rate_type: "sss_pct", value: 4.5, effective_date: "" })).status).toBe(400);
    expect(saved()).toHaveLength(0);
  });

  it("future pay periods only: a date before the next period's first day is refused", async () => {
    const response = await post("hr", { rate_type: "sss_pct", value: 4.5, effective_date: "2026-01-01" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("future_periods_only");
    expect(saved()).toHaveLength(0);
  });

  it("refuses a date inside a period whose payroll is being processed (decision 2026-11-09 #6)", async () => {
    table("payroll_runs").push({ id: "run-1", period_label: "December 1-15, 2026", period_start: "2026-12-01", period_end: "2026-12-15", status: "pending" });
    const res = await post("hr", { rate_type: "sss_pct", value: 4.5, effective_date: "2026-12-05" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "period_in_processing", min_effective_date: "2026-12-16" });
    expect(saved()).toHaveLength(0);
  });

  it("nobody changes their own rate: refused and logged; another HR does it, logged as the fallback", async () => {
    const own = await post("hr", { rate_type: "daily", scope: "employee", scope_ref: "u-hr", value: 900 });
    expect(own.status).toBe(403);
    expect((await own.json()).code).toBe("own_rate");
    expect(table("audit_logs").at(-1)).toMatchObject({ action: "own_rate_blocked", status: "failed" });
    expect(saved()).toHaveLength(0);
    const other = { userId: "u-hr2", role: "hr", branchId: null, fullName: "Hugo HR" };
    const res = await (await hrRoute()).POST(requestAs(other, "/api/payroll/rates", "POST", { rate_type: "daily", scope: "employee", scope_ref: "u-hr", value: 900, effective_date: "2026-12-01", note: "Promotion" }));
    expect(res.status).toBe(200);
    expect(table("audit_logs").at(-1).metadata.fallback_for).toMatchObject({ id: "u-hr", role: "hr" });
  });

  it("the Accountant, Admin and Employee cannot write through the HR route (handler and proxy)", async () => {
    const { proxy } = await import("@/proxy");
    for (const role of ["accountant", "admin", "employee"]) {
      expect((await post(role, { rate_type: "sss_pct", value: 4.5 })).status, role).toBe(403);
      expect((await proxy(requestAs(PEOPLE[role], "/api/payroll/rates", "POST", { rate_type: "sss_pct", value: 4.5 }))).status, `proxy ${role}`).toBe(403);
    }
    expect(saved()).toHaveLength(0);
  });

  it("HR changes the SSS salary credit table and contribution amounts with a reason; never its own; the Super Admin is notified (decision #4)", async () => {
    const settings = await import("@/app/api/payroll/settings/route");
    const call = (who, body) => settings.POST(requestAs(PEOPLE[who], "/api/payroll/settings", "POST", { effective_date: "2027-01-01", ...body }));
    const rows = [...MSC, { salary_from: 35250, msc: 35500 }];
    expect((await call("hr", { kind: "sss_msc_table", rows })).status).toBe(400); // no reason
    expect((await call("hr", { kind: "sss_msc_table", rows, note: "SSS Circular 2026-1" })).status).toBe(200);
    expect((await call("hr", { kind: "contribution", employee_id: "u-hr", sss: 0, note: "Exempt" })).status).toBe(403);
    expect((await call("hr", { kind: "tax_table", rows: TAX, note: "BIR" })).status).toBe(403);
    expect((await call("accountant", { kind: "sss_msc_table", rows, note: "x" })).status).toBe(403);
    expect(table("notifications").some((n) => n.kind === "rate_change" && /SSS salary credit table/.test(n.title))).toBe(true);
  });

  it("the database guard (20261109020000) lets HR write only the daily and government rates, never its own, never without a reason or in the past", () => {
    const sql = readFileSync("supabase/migrations/20261109020000_hr_rate_changes.sql", "utf8");
    expect(sql).toMatch(/v_role = 'super_admin' OR \(v_role = 'hr' AND v_type = ANY \(v_hr_types\)\)/);
    expect(sql).toMatch(/NEW\.scope_ref::TEXT = NEW\.created_by::TEXT/);
    expect(sql).toContain("reason_required");
    expect(sql).toContain("future_periods_only");
    expect(sql).not.toMatch(/'hourly'/);
    expect(sql).toContain("('hr',          'government_rates', 'all', true, true, false, false)");
  });
});

describe("a future rate never reaches an earlier payroll", () => {
  it("Pag-IBIG 3% from Dec 1: November still deducts 2% (₱200), December 3% (₱300)", () => {
    const configs = [...table("payroll_rate_configs"), rate("pagibig_pct", 3, "2026-12-01", "2026-10-26T00:00:00Z")];
    const at = (periodStart) => monthlyContributions(18000, rateValues(resolveRates(configs, { employeeId: "x", monthlySalary: 18000 }, periodStart)));
    expect(at("2026-11-16").pagibig).toBe(200);
    expect(at("2026-12-16").pagibig).toBe(300);
  });
});

describe("the database side (20261026030000)", () => {
  const sql = readFileSync("supabase/migrations/20261026030000_government_rates_access.sql", "utf8");

  it("checks every server write for a Super Admin, as the caller (not the function owner)", () => {
    expect(sql).toMatch(/FUNCTION public\.payroll_rate_writer_guard\(\)[\s\S]*?SECURITY INVOKER/);
    expect(sql).toMatch(/current_user NOT IN \('service_role', 'authenticated', 'anon'\)/);
    expect(sql).toMatch(/v_role IS DISTINCT FROM 'super_admin' OR v_archived/);
    expect(sql).toMatch(/ARRAY\['payroll_rate_configs', 'payroll_tax_brackets', 'payroll_contribution_amounts', 'payroll_sss_msc_brackets'\]/);
    expect(sql).toContain("CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_writer_guard()");
  });

  it("keeps browsers out entirely: no grants, no read policy for any client role", () => {
    expect(sql).toContain("REVOKE ALL ON public.%I FROM anon, authenticated");
    expect(sql).toContain("FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)");
    expect(sql).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+(anon|authenticated)/i);
    expect(sql).not.toMatch(/FOR SELECT TO authenticated/i);
  });

  it("seeds the same matrix as the app, and makes the history append-only", () => {
    expect(sql).toContain("('employee',    'government_rates', 'none',   false, false, false, false)");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_rate_history_append_only()");
  });
});
