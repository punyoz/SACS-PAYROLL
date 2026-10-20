/**
 * The branch Admin's oversight (20261020020000): the Admin recommends, HR
 * decides, and nothing of another branch is ever reachable, even by calling
 * the API directly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ADMIN_A = "11111111-0000-4000-8000-0000000000a1";
const ADMIN_B = "11111111-0000-4000-8000-0000000000b1";
const HR = "22222222-0000-4000-8000-000000000001";
const ANA = "33333333-0000-4000-8000-0000000000a1"; // branch A employee
const BEN = "33333333-0000-4000-8000-0000000000b1"; // branch B employee
const LOG_A = "44444444-0000-4000-8000-0000000000a1";
const LOG_B = "44444444-0000-4000-8000-0000000000b1";
const TR_B = "55555555-0000-4000-8000-0000000000b1";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

const who = {
  adminA: { user_id: ADMIN_A, role: "admin", branch_id: A, full_name: "Ada Admin" },
  adminB: { user_id: ADMIN_B, role: "admin", branch_id: B, full_name: "Bo Admin" },
  hr: { user_id: HR, role: "hr", branch_id: null, full_name: "Hana HR" },
  ana: { user_id: ANA, role: "employee", branch_id: A, full_name: "Ana Reyes" },
  ben: { user_id: BEN, role: "employee", branch_id: B, full_name: "Ben Cruz" },
};

let createSessionToken;
let SESSION_COOKIE;
let oversight;
let hrRequests;
let announcements;
let leaves;

function req(as, path, method = "GET", body = null, headers = {}) {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: `s-${as.user_id}` });
  const request = new Request(`https://sacs.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  request.nextUrl = new URL(request.url);
  return request;
}
const json = async (p) => { const r = await p; return { status: r.status, body: await r.json().catch(() => ({})) }; };
const file = (as, { kind, employee_id, ref_id, decision, note, ...details }) => json(oversight.POST(req(as, "/api/admin/branch-oversight", "POST", { action: "file", kind, employee_id, ref_id, decision, note, details })));
const view = (as, q) => json(oversight.GET(req(as, `/api/admin/branch-oversight?${q}`)));

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-branch-oversight";
  resetDb();
  table("branches").push({ id: A, name: "Main", status: "active" }, { id: B, name: "Annex", status: "active" });
  table("profiles").push(
    { id: ADMIN_A, role: "admin", branch_id: A, full_name: "Ada Admin", archived: false },
    { id: ADMIN_B, role: "admin", branch_id: B, full_name: "Bo Admin", archived: false },
    { id: HR, role: "hr", branch_id: null, full_name: "Hana HR", archived: false },
    { id: ANA, role: "employee", branch_id: A, full_name: "Ana Reyes", employee_id: "SACS-001", employee_type: "Teaching", archived: false, basic_salary: 30000 },
    { id: BEN, role: "employee", branch_id: B, full_name: "Ben Cruz", employee_id: "SACS-002", employee_type: "Teaching", archived: false, basic_salary: 40000 },
  );
  users.push(
    { id: ANA, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Reyes", branch_id: A } },
    { id: BEN, email: "ben@sacs.test", user_metadata: { role: "employee", full_name: "Ben Cruz", branch_id: B } },
    { id: HR, email: "hr@sacs.test", user_metadata: { role: "hr", full_name: "Hana HR" } },
  );
  table("attendance_logs").push(
    { id: LOG_A, employee_id: ANA, employee_name: "Ana Reyes", log_date: TODAY, status: "Late", time_in: `${TODAY}T00:40:00Z`, late_minutes: 10, archived_duplicate: false },
    { id: LOG_B, employee_id: BEN, employee_name: "Ben Cruz", log_date: TODAY, status: "On Time", time_in: `${TODAY}T00:00:00Z`, archived_duplicate: false },
  );
  table("leave_requests").push(
    { id: "lr-a", employee_id: ANA, employee_name: "Ana Reyes", branch_id: A, leave_type: "Sick", start_date: TODAY, end_date: TODAY, status: "pending_admin", reason: "Fever", pay_status: "with_pay", submitted_at: new Date().toISOString() },
    { id: "lr-b", employee_id: BEN, employee_name: "Ben Cruz", branch_id: B, leave_type: "Vacation", start_date: TODAY, end_date: TODAY, status: "pending_admin", reason: "Trip", pay_status: "with_pay", submitted_at: new Date().toISOString() },
  );
  table("transfer_requests").push({ id: TR_B, employee_id: BEN, from_branch_id: B, to_branch_id: B, status: "pending", created_at: new Date().toISOString() });
  table("payroll_run_summaries").push(
    { id: "run-a", branch_id: A, period_label: "October 1-15, 2026", period_start: "2026-10-01", cutoff_type: "first", status: "approved", total_employees: 1, total_gross: 15000, total_deductions: 0, total_net: 15000, reviewed_at: new Date().toISOString(), reviewed_by_name: "Hana HR" },
    { id: "run-b", branch_id: B, period_label: "October 1-15, 2026", period_start: "2026-10-01", cutoff_type: "first", status: "approved", total_employees: 1, total_gross: 20000, total_deductions: 0, total_net: 20000 },
    { id: "run-a2", branch_id: A, period_label: "October 16-31, 2026", period_start: "2026-10-16", cutoff_type: "second", status: "pending", total_employees: 1, total_gross: 15000, total_deductions: 900, total_net: 14100 },
  );
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  oversight = await import("@/app/api/admin/branch-oversight/route");
  hrRequests = await import("@/app/api/hr/branch-requests/route");
  announcements = await import("@/app/api/announcements/route");
  leaves = await import("@/app/api/hr/leave-requests/route");
});

describe("branch isolation", () => {
  it("the Admin of branch A sees only branch A, in every view", async () => {
    const att = await view(who.adminA, `view=attendance&from=${TODAY}&to=${TODAY}`);
    expect(att.body.logs.map((l) => l.id)).toEqual([LOG_A]);
    const lv = await view(who.adminA, "view=leaves");
    expect(lv.body.leaves.map((l) => l.id)).toEqual(["lr-a"]);
    const emp = await view(who.adminA, "view=employees");
    expect(emp.body.employees.map((e) => e.id)).toEqual([ANA]);
    const tr = await view(who.adminA, "view=transfers");
    expect(tr.body.transfers).toEqual([]);
    const dash = await view(who.adminA, "view=dashboard");
    expect(dash.body.headcount.total).toBe(1);
  });

  it("refuses branch B's records to the Admin of branch A, by id", async () => {
    expect((await file(who.adminA, { kind: "attendance_flag", ref_id: LOG_B, note: "Wrong time" })).status).toBe(404);
    expect((await file(who.adminA, { kind: "leave_endorsement", ref_id: "lr-b", decision: "endorse", note: "Fine by me" })).status).toBe(404);
    expect((await file(who.adminA, { kind: "transfer_endorsement", ref_id: TR_B, decision: "endorse", note: "Fine by me" })).status).toBe(404);
    expect((await file(who.adminA, { kind: "incident_report", employee_id: BEN, incident_type: "no_show", incident_date: TODAY, note: "Absent" })).status).toBe(404);
    expect(table("branch_admin_requests")).toHaveLength(0);
  });

  it("an Admin cannot change another branch's announcement", async () => {
    const posted = await json(announcements.POST(req(who.adminB, "/api/announcements", "POST", { title: "Annex meeting", body: "3 PM", category: "meeting" })));
    expect(posted.status).toBe(200);
    const id = posted.body.announcement.id;
    expect((await json(announcements.PATCH(req(who.adminA, "/api/announcements", "PATCH", { id, action: "remove" })))).status).toBe(404);
    expect((await json(announcements.GET(req(who.adminA, "/api/announcements")))).body.announcements).toEqual([]);
  });
});

describe("the Admin cannot decide", () => {
  it("refuses HR's decisions and the Admin's own payroll / approval routes", async () => {
    await file(who.adminA, { kind: "schedule_request", employee_id: ANA, request_type: "schedule", effective_from: TODAY, requested: "7 to 3", note: "Please" });
    const id = table("branch_admin_requests")[0].id;
    expect((await json(hrRequests.PATCH(req(who.adminA, "/api/hr/branch-requests", "PATCH", { id, decision: "approve", note: "self" })))).status).toBe(403);
    expect((await json(hrRequests.GET(req(who.adminA, "/api/hr/branch-requests")))).status).toBe(403);
    const { proxy } = await import("@/proxy");
    for (const [path, method] of [["/api/accountant/payroll", "POST"], ["/api/hr/payroll-runs", "PATCH"], ["/api/admin/approvals", "PATCH"], ["/api/hr/employees", "POST"], ["/api/admin/config", "PATCH"]]) {
      expect((await proxy(req(who.adminA, path, method, method === "GET" ? null : {}))).status, `${method} ${path}`).toBe(403);
    }
    // The old dashboard lists salaries: its route refuses the Admin.
    const oldDashboard = await import("@/app/api/admin/dashboard/route");
    expect((await oldDashboard.GET(req(who.adminA, "/api/admin/dashboard"))).status).toBe(403);
  });
});

describe("leave recommendation", () => {
  it("the Admin endorses, HR sees it and decides, the Admin sees the result and is notified", async () => {
    expect((await file(who.adminA, { kind: "leave_endorsement", ref_id: "lr-a", decision: "endorse", note: "Has a medical certificate" })).status).toBe(200);
    const hrView = await json(hrRequests.GET(req(who.hr, "/api/hr/branch-requests?kind=leave_endorsement")));
    expect(hrView.body.requests[0]).toMatchObject({ ref_id: "lr-a", status: "endorsed", status_label: "Endorsed", admin_note: "Has a medical certificate", branch_name: "Main" });
    expect(table("notifications").some((n) => n.recipient_id === HR)).toBe(true);
    const decided = await json(leaves.PATCH(req(who.hr, "/api/hr/leave-requests", "PATCH", { id: "lr-a", action: "approve" })));
    expect(decided.status).toBe(200);
    expect(table("notifications").some((n) => n.recipient_id === ADMIN_A && n.kind === "leave_endorsement_decided")).toBe(true);
    const after = await view(who.adminA, "view=leaves");
    expect(after.body.leaves[0]).toMatchObject({ status: "approved", hr_status_label: "Approved", recommendation: expect.objectContaining({ status: "endorsed" }) });
  });
});

describe("incident report", () => {
  it("a no-show opens a flagged case in HR's AWOL Cases; HR resolves the report; the Admin sees it", async () => {
    const filed = await file(who.adminA, { kind: "incident_report", employee_id: ANA, incident_type: "no_show", incident_date: TODAY, note: "Did not come in, no call" });
    expect(filed.status).toBe(200);
    expect(table("employee_awol_cases")).toEqual([expect.objectContaining({ employee_id: ANA, branch_id: A, stage: "flagged" })]);
    const id = filed.body.request.id;
    expect((await json(hrRequests.PATCH(req(who.hr, "/api/hr/branch-requests", "PATCH", { id, decision: "approve", note: "x" })))).status).toBe(400);
    expect((await json(hrRequests.PATCH(req(who.hr, "/api/hr/branch-requests", "PATCH", { id, decision: "resolve", note: "Case opened; notices sent" })))).status).toBe(200);
    const mine = await view(who.adminA, "view=requests&kind=incident_report");
    expect(mine.body.requests[0]).toMatchObject({ status: "resolved", decision_note: "Case opened; notices sent", decided_by_role: "hr" });
    expect(mine.body.requests[0].history.map((h) => h.status)).toEqual(["pending", "resolved"]);
  });
});

describe("announcements", () => {
  it("reach the branch's employees only", async () => {
    const posted = await json(announcements.POST(req(who.adminA, "/api/announcements", "POST", { title: "Faculty meeting", body: "Friday 3 PM", category: "meeting" })));
    expect(posted.status).toBe(200);
    expect(table("notifications").filter((n) => n.kind === "branch_announcement").map((n) => n.recipient_id)).toEqual([ANA]);
    expect((await json(announcements.GET(req(who.ana, "/api/announcements")))).body.announcements.map((a) => a.title)).toEqual(["Faculty meeting"]);
    expect((await json(announcements.GET(req(who.ben, "/api/announcements")))).body.announcements).toEqual([]);
    expect((await json(announcements.POST(req(who.ana, "/api/announcements", "POST", { title: "Hi", body: "x" })))).status).toBe(403);
  });
});

describe("branch payroll summary", () => {
  it("shows approved run totals of the branch only, never an employee's pay", async () => {
    const { body } = await view(who.adminA, "view=payroll");
    expect(body.periods).toHaveLength(1);
    expect(body.periods[0]).toMatchObject({ period_label: "October 1-15, 2026", total_gross: 15000, total_net: 15000, employees: 1 });
    expect(JSON.stringify(body)).not.toMatch(/basic_salary|net_pay|employee_id|payslip/);
    const dash = await view(who.adminA, "view=dashboard");
    expect(JSON.stringify(dash.body)).not.toMatch(/salary|net_pay|gross/);
  });
});

describe("incentive recommendation", () => {
  it("HR's approval files the incentive item, counted by the day HR approves it", async () => {
    const ok = await file(who.adminA, { kind: "incentive_endorsement", employee_id: ANA, note: "Coached the winning team", item_date: "2026-10-05", amount: 750, description: "Quiz bee coach", ...{ ["kind"]: "incentive_endorsement" } });
    expect(ok.status).toBe(400); // details.kind (incentive / overload) is required
    const filed = await json(oversight.POST(req(who.adminA, "/api/admin/branch-oversight", "POST", { action: "file", kind: "incentive_endorsement", employee_id: ANA, note: "Coached the winning team", details: { kind: "incentive", item_date: "2026-10-05", amount: 750, description: "Quiz bee coach" } })));
    expect(filed.status).toBe(200);
    expect((await json(hrRequests.PATCH(req(who.hr, "/api/hr/branch-requests", "PATCH", { id: filed.body.request.id, decision: "approve", note: "Approved" })))).status).toBe(200);
    expect(table("payroll_monthly_incentives")).toEqual([expect.objectContaining({ employee_id: ANA, kind: "incentive", amount: 750, item_date: "2026-10-05", created_by: HR })]);
  });
});
