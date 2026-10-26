/**
 * Incentives, overload and loans need HR approval before payroll uses them
 * (20261027020000, decision 2026-10-27). The Accountant files; HR approves or
 * rejects; payroll pays or deducts only approved items; both see the status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";
import { filedAtOf, isApproved } from "@/lib/payroll/adjustment-approvals";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "00000000-0000-4000-8000-00000000b001";
const OTHER = "00000000-0000-4000-8000-00000000b002";
const ANA = "00000000-0000-4000-8000-0000000000e1";
const HR_ID = "00000000-0000-4000-8000-0000000000b1";
const ACCT_ID = "00000000-0000-4000-8000-0000000000a9";
const WHO = {
  hr: { user_id: HR_ID, role: "hr", branch_id: null, full_name: "HR Officer" },
  accountant: { user_id: ACCT_ID, role: "accountant", branch_id: BRANCH, full_name: "Payroll JM" },
  other_accountant: { user_id: "00000000-0000-4000-8000-0000000000a8", role: "accountant", branch_id: OTHER, full_name: "North Accountant" },
  employee: { user_id: ANA, role: "employee", branch_id: BRANCH, full_name: "Ana Main" },
};
const rate = (rateType, value, effectiveDate = "2026-10-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

let createSessionToken;
let SESSION_COOKIE;
const request = (url, method = "GET", body, who = WHO.accountant) => {
  const req = new Request(`https://sacs.test${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: `s-${who.user_id}`, email: `${who.user_id}@sacs.test`, ...who })}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  req.nextUrl = new URL(req.url);
  return req;
};

/** The database's payroll_adjustment_decide(), as 20261027020000 writes it. */
function fakeDecide({ p_actor: actor, p_kind: kind, p_id: id, p_decision: decision, p_note: note }) {
  const who = table("profiles").find((p) => p.id === actor);
  if (!who || who.role !== "hr" || who.archived) return { data: null, error: { message: "forbidden: only HR approves or rejects incentives, overload and loans." } };
  const row = table(kind === "loan" ? "payroll_loans" : "payroll_monthly_incentives").find((r) => r.id === id);
  if (!row) return { data: null, error: { message: "not_found: no such item." } };
  if ((row.approval_status || "approved") !== "pending") return { data: null, error: { message: `already_decided: it is already ${row.approval_status}.` } };
  Object.assign(row, { approval_status: decision === "approve" ? "approved" : "rejected", decided_by: actor, decided_by_name: who.full_name, decided_at: new Date().toISOString(), decision_note: note || null });
  return { data: [{ id: row.id, employee_id: row.employee_id, approval_status: row.approval_status, created_by: row.created_by }], error: null };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-adjustment-approvals";
  resetDb();
  table("branches").push({ id: BRANCH, name: "Main" }, { id: OTHER, name: "North" });
  users.push({ id: ANA, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Main", employee_id: "SACS-601", basic_salary: 18000, branch_id: BRANCH } });
  table("profiles").push(
    { id: ANA, full_name: "Ana Main", email: "ana@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-601", archived: false, basic_salary: 18000, date_hired: "2024-06-01" },
    { id: HR_ID, role: "hr", branch_id: null, full_name: "HR Officer", archived: false },
    { id: ACCT_ID, role: "accountant", branch_id: BRANCH, full_name: "Payroll JM", archived: false },
  );
  table("payroll_rate_configs").push(
    rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("contribution_method", 0),
    rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2), rate("sss_msc_min", 5000), rate("sss_msc_max", 35000),
    rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
  );
  table("payroll_tax_brackets").push({ id: "bir-0", version_id: "bir", effective_date: "2023-01-01", bracket_over: 0, base_tax: 0, rate_pct: 0, created_at: "2023-01-01T00:00:00Z" });
  rpc.results.payroll_adjustment_decide = fakeDecide;
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

const fileIncentive = async (over = {}) => {
  const { POST } = await import("@/app/api/accountant/payroll/route");
  return withUuid("payroll_monthly_incentives", await POST(request("/api/accountant/payroll", "POST", { action: "add_monthly_item", employee_id: ANA, kind: "incentive", amount: 1000, item_date: "2026-11-05", description: "Coaching", ...over })));
};
/** Real rows have UUID ids and archived = false by default (the fake database has neither). */
function withUuid(name, response) {
  table(name).forEach((row) => {
    if (!/^[0-9a-f-]{36}$/.test(String(row.id))) row.id = randomUUID();
    if (row.archived === undefined) row.archived = false;
  });
  return response;
}
const novemberIncentive = async () => {
  const { GET } = await import("@/app/api/accountant/payroll/route");
  vi.setSystemTime(new Date("2026-12-01T09:00:00+08:00"));
  const body = await (await GET(request(`/api/accountant/payroll?period=${encodeURIComponent("November 16-30, 2026")}`))).json();
  return body.attendance_rows.find((r) => r.employee_id === ANA).defaults.other_incentive;
};
const decide = async (kind, id, decision, note, who = WHO.hr) => {
  const { PATCH } = await import("@/app/api/hr/adjustment-approvals/route");
  return PATCH(request("/api/hr/adjustment-approvals", "PATCH", { kind, id, decision, note }, who));
};

describe("an incentive filed by the Accountant", () => {
  it("waits for HR: pending, HR notified, not paid", async () => {
    const res = await fileIncentive();
    expect(res.status).toBe(200);
    expect((await res.json()).approval_status).toBe("pending");
    expect(table("payroll_monthly_incentives")[0]).toMatchObject({ approval_status: "pending", created_by: ACCT_ID });
    expect(table("notifications").find((n) => n.recipient_id === HR_ID)).toMatchObject({ kind: "adjustment_approval", title: "Incentive to approve: Ana Main" });
    expect(await novemberIncentive()).toBe(0);
  });

  it("is paid once HR approves it; the Accountant is notified", async () => {
    await fileIncentive();
    const id = table("payroll_monthly_incentives")[0].id;
    expect((await decide("incentive", id, "approve")).status).toBe(200);
    expect(table("payroll_monthly_incentives")[0]).toMatchObject({ approval_status: "approved", decided_by_name: "HR Officer" });
    expect(table("notifications").find((n) => n.recipient_id === ACCT_ID)).toMatchObject({ kind: "adjustment_decision" });
    expect(await novemberIncentive()).toBe(1000);
  });

  it("is never paid when HR rejects it, and a rejection needs a reason", async () => {
    await fileIncentive();
    const id = table("payroll_monthly_incentives")[0].id;
    expect((await decide("incentive", id, "reject", "")).status).toBe(400);
    expect((await decide("incentive", id, "reject", "Not in the coaching roster")).status).toBe(200);
    expect(await novemberIncentive()).toBe(0);
    expect((await decide("incentive", id, "approve")).status).toBe(409);
  });

  it("approved after the month's lock date: paid next month, never lost", async () => {
    await fileIncentive();
    const item = table("payroll_monthly_incentives")[0];
    vi.setSystemTime(new Date("2026-12-02T09:00:00+08:00"));
    await decide("incentive", item.id, "approve");
    expect(isApproved(item)).toBe(true);
    expect(String(filedAtOf(item)).slice(0, 10)).toBe("2026-12-02");
    const { GET } = await import("@/app/api/accountant/payroll/route");
    const body = await (await GET(request("/api/accountant/payroll?view=monthly_items&month=2026-12"))).json();
    expect(body.items.find((i) => i.id === item.id)).toMatchObject({ payroll_month: "2026-12", approval_status: "approved", approval_label: "Approved by HR" });
  });
});

describe("a loan filed by the Accountant", () => {
  it("is pending until HR approves; payroll deducts approved loans only", async () => {
    const { POST } = await import("@/app/api/accountant/loans/route");
    const res = await POST(request("/api/accountant/loans", "POST", {
      action: "create_loan", employee_id: ANA, loan_type: "salary_loan", principal: 2000, number_of_payrolls: 2, date_granted: "2026-11-10", start_period: "2026-11-16", description: "Emergency",
    }));
    expect(res.status).toBe(200);
    withUuid("payroll_loans");
    const loan = table("payroll_loans")[0];
    expect(loan).toMatchObject({ approval_status: "pending" });
    Object.assign(loan, { status: "active", remaining_balance: 2000, total_payable: 2000 });
    const { loadLoanContext } = await import("@/lib/payroll/loans");
    const period = { start_key: "2026-11-16", end_key: "2026-11-30", label: "November 16-30, 2026" };
    expect((await loadLoanContext((await import("@/lib/supabase/admin")).getServiceClient(), [ANA], period)).byEmployee.get(ANA)).toBeUndefined();
    expect((await decide("loan", loan.id, "approve")).status).toBe(200);
    expect((await loadLoanContext((await import("@/lib/supabase/admin")).getServiceClient(), [ANA], period)).byEmployee.get(ANA)).toHaveLength(1);
  });
});

describe("who sees and who decides", () => {
  it("HR sees every branch and can decide; the Accountant sees its branch, read-only", async () => {
    await fileIncentive();
    table("payroll_monthly_incentives").push({ id: "00000000-0000-4000-8000-0000000000f9", employee_id: ANA, branch_id: OTHER, item_date: "2026-11-05", kind: "incentive", description: "North item", amount: 50, archived: false, approval_status: "pending", created_at: "2026-11-09T00:00:00Z" });
    const { GET } = await import("@/app/api/hr/adjustment-approvals/route");
    const hr = await (await GET(request("/api/hr/adjustment-approvals", "GET", null, WHO.hr))).json();
    expect(hr).toMatchObject({ can_decide: true, pending: 2 });
    const acct = await (await GET(request("/api/hr/adjustment-approvals", "GET", null, WHO.accountant))).json();
    expect(acct).toMatchObject({ can_decide: false, pending: 1 });
    expect(acct.items.map((i) => i.detail)).toEqual([expect.stringContaining("Coaching")]);
  });

  it("only HR decides: the Accountant and Employee are refused by the route and the proxy", async () => {
    await fileIncentive();
    const id = table("payroll_monthly_incentives")[0].id;
    expect((await decide("incentive", id, "approve", "", WHO.accountant)).status).toBe(403);
    const { GET } = await import("@/app/api/hr/adjustment-approvals/route");
    expect((await GET(request("/api/hr/adjustment-approvals", "GET", null, WHO.employee))).status).toBe(403);
    const { proxy } = await import("@/proxy");
    expect((await proxy(request("/api/hr/adjustment-approvals", "PATCH", { kind: "incentive", id, decision: "approve" }, WHO.accountant))).status).toBe(403);
    expect(table("payroll_monthly_incentives")[0].approval_status).toBe("pending");
  });

  it("the database keeps the same rules", () => {
    const sql = readFileSync("supabase/migrations/20261027020000_adjustment_approvals.sql", "utf8");
    expect(sql).toMatch(/IF NEW\.approval_status <> 'approved' OR v_role IS NULL OR v_role NOT IN \('hr', 'super_admin'\)/);
    expect(sql).toMatch(/IF v_actor\.id IS NULL OR v_actor\.role <> 'hr' OR v_actor\.archived/);
    expect(sql).toContain("only HR approves or rejects it (payroll_adjustment_decide)");
    expect(sql).toContain("give the reason for rejecting it (at least 5 characters)");
  });
});
