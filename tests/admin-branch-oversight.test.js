/**
 * The branch Admin's oversight (20261020020000): the Admin recommends, HR
 * decides, and nothing of another branch is ever reachable, even by calling
 * the API directly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";

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
  sa: { user_id: "66666666-0000-4000-8000-000000000001", role: "super_admin", branch_id: null, full_name: "Sam Super" },
  acct: { user_id: "77777777-0000-4000-8000-0000000000a1", role: "accountant", branch_id: A, full_name: "Ace Accountant" },
};

/*
 * announcement_post / _edit / _remove (20261030010000), as the database
 * decides: HR any audience; an Admin its own branch, its own posts; the
 * Super Admin deletes only; nobody else writes.
 */
function fakeAnnouncements() {
  const fail = (message) => ({ data: null, error: { message } });
  const actor = (id) => table("profiles").find((p) => p.id === id && !p.archived);
  const textError = ({ p_title, p_body }) => {
    if (!String(p_title || "").trim() || String(p_title).trim().length > 100) return "invalid_title: the title is required, at most 100 characters.";
    if (!String(p_body || "").trim() || String(p_body).trim().length > 1000) return "invalid_message: the message is required, at most 1,000 characters.";
    return null;
  };
  const ownsIt = (who, row) => who.role === "admin" && row.created_by === who.id && who.branch_id && row.branch_id === who.branch_id;
  rpc.results.announcement_post = (args) => {
    const who = actor(args.p_actor);
    if (!who || !["hr", "admin"].includes(who.role)) return fail("forbidden: only HR and the branch Admin post announcements.");
    if (who.role === "admin" && (!who.branch_id || args.p_branch !== who.branch_id)) return fail("forbidden_audience: a branch Admin announces to its own branch only, never school-wide or to another branch.");
    const bad = textError(args);
    if (bad) return fail(bad);
    const row = {
      id: `a${String(table("branch_announcements").length + 1).padStart(7, "0")}-0000-4000-8000-000000000000`, branch_id: args.p_branch || null,
      title: args.p_title.trim(), body: args.p_body.trim(), category: args.p_category || "general", archived: false, author_role: who.role,
      expires_on: args.p_expires_on || null, created_by: who.id, created_by_name: who.full_name, created_at: new Date().toISOString(),
    };
    table("branch_announcements").push(row);
    return { data: row, error: null };
  };
  rpc.results.announcement_edit = (args) => {
    const who = actor(args.p_actor);
    const row = table("branch_announcements").find((r) => r.id === args.p_id);
    if (!row || row.archived) return fail("not_found: no such announcement.");
    if (!who || !(who.role === "hr" || ownsIt(who, row))) return fail("forbidden: only its author (a branch Admin, in their branch) or HR can change this announcement.");
    const bad = textError(args);
    if (bad) return fail(bad);
    Object.assign(row, { title: args.p_title.trim(), body: args.p_body.trim(), expires_on: args.p_expires_on || null, ...(who.role === "hr" && args.p_set_audience ? { branch_id: args.p_branch || null } : {}) });
    return { data: row, error: null };
  };
  rpc.results.announcement_remove = (args) => {
    const who = actor(args.p_actor);
    const row = table("branch_announcements").find((r) => r.id === args.p_id);
    if (!row || row.archived) return fail("not_found: no such announcement.");
    if (!who || !(["hr", "super_admin"].includes(who.role) || ownsIt(who, row))) return fail("forbidden: only its author (a branch Admin, in their branch), HR or the Super Admin can delete this announcement.");
    Object.assign(row, { archived: true, archived_at: new Date().toISOString() });
    return { data: row, error: null };
  };
}

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
  fakeAnnouncements();
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
  // A Super Admin and an Accountant (branch A), for these tests only.
  beforeEach(() => {
    table("profiles").push(
      { id: who.sa.user_id, role: "super_admin", branch_id: null, full_name: "Sam Super", archived: false },
      { id: who.acct.user_id, role: "accountant", branch_id: A, full_name: "Ace Accountant", archived: false },
    );
  });
  const post = (as, body) => json(announcements.POST(req(as, "/api/announcements", "POST", body)));
  const feed = async (as) => (await json(announcements.GET(req(as, "/api/announcements")))).body.announcements.map((a) => a.title);

  it("reach the branch's employees only", async () => {
    const posted = await post(who.adminA, { title: "Faculty meeting", body: "Friday 3 PM", category: "meeting" });
    expect(posted.status).toBe(200);
    expect(table("notifications").filter((n) => n.kind === "branch_announcement").map((n) => n.recipient_id).sort()).toEqual([ANA, who.acct.user_id].sort());
    expect(await feed(who.ana)).toEqual(["Faculty meeting"]);
    expect(await feed(who.ben)).toEqual([]);
    expect((await post(who.ana, { title: "Hi", body: "x" })).status).toBe(403);
  });

  it("HR posts school-wide and to one branch; each reader sees school-wide plus its own branch", async () => {
    expect((await post(who.hr, { title: "Holiday", body: "No classes Nov 2", category: "holiday" })).status).toBe(400); // audience required
    expect((await post(who.hr, { title: "Holiday", body: "No classes Nov 2", category: "holiday", audience: "all" })).status).toBe(200);
    expect((await post(who.hr, { title: "Annex drill", body: "Fire drill at 10 AM", audience: B })).status).toBe(200);
    expect(await feed(who.ana)).toEqual(["Holiday"]);
    expect((await feed(who.ben)).sort()).toEqual(["Annex drill", "Holiday"]);
    expect(await feed(who.acct)).toEqual(["Holiday"]);
    // The school-wide one reached every branch's staff; the branch one only branch B's.
    const sent = table("notifications").filter((n) => n.kind === "branch_announcement");
    expect(sent.filter((n) => n.title.includes("Holiday")).map((n) => n.recipient_id)).toEqual(expect.arrayContaining([ANA, BEN, who.acct.user_id, ADMIN_A, ADMIN_B]));
    expect(sent.filter((n) => n.title.includes("Annex drill")).map((n) => n.recipient_id).sort()).toEqual([ADMIN_B, BEN].sort());
    expect(sent.find((n) => n.recipient_id === ANA).link_page).toBe("emp-announcements");
    expect(table("audit_logs").filter((l) => l.action === "announcement_post")).toHaveLength(2);
  });

  it("an Admin never posts school-wide or to another branch, nor touches HR's or another Admin's", async () => {
    expect((await post(who.adminA, { title: "To all", body: "x", audience: "all" })).status).toBe(403);
    expect((await post(who.adminA, { title: "To Annex", body: "x", audience: B })).status).toBe(403);
    const hrPost = (await post(who.hr, { title: "HR notice", body: "For Main", audience: A })).body.announcement;
    const bPost = (await post(who.adminB, { title: "Annex only", body: "x" })).body.announcement;
    const edit = (as, id) => json(announcements.PATCH(req(as, "/api/announcements", "PATCH", { id, action: "edit", title: "Changed", body: "Changed" })));
    const del = (as, id) => json(announcements.DELETE(req(as, "/api/announcements", "DELETE", { id })));
    expect((await edit(who.adminA, hrPost.id)).status).toBe(403);
    expect((await del(who.adminA, hrPost.id)).status).toBe(403);
    expect((await edit(who.adminA, bPost.id)).status).toBe(404); // another branch's: not even known
    expect((await del(who.adminA, bPost.id)).status).toBe(404);
    expect(table("branch_announcements").every((a) => !a.archived && a.title !== "Changed")).toBe(true);
    // Its own: edited and deleted (kept on file, hidden).
    const mine = (await post(who.adminA, { title: "Main meeting", body: "3 PM" })).body.announcement;
    expect((await edit(who.adminA, mine.id)).status).toBe(200);
    expect((await del(who.adminA, mine.id)).status).toBe(200);
    expect(await feed(who.ana)).toEqual(["HR notice"]);
    expect(table("audit_logs").map((l) => l.action)).toEqual(expect.arrayContaining(["announcement_edit", "announcement_remove"]));
  });

  it("Accountant and Employee read only; the Super Admin moderates (delete) but does not post", async () => {
    const hrPost = (await post(who.hr, { title: "Payday", body: "Oct 31", audience: "all" })).body.announcement;
    for (const as of [who.acct, who.ana]) {
      expect((await post(as, { title: "x", body: "y", audience: A })).status).toBe(403);
      expect((await json(announcements.PATCH(req(as, "/api/announcements", "PATCH", { id: hrPost.id, action: "edit", title: "x", body: "y" })))).status).toBe(403);
      expect((await json(announcements.DELETE(req(as, "/api/announcements", "DELETE", { id: hrPost.id })))).status).toBe(403);
    }
    expect((await post(who.sa, { title: "x", body: "y", audience: "all" })).status).toBe(403);
    const list = await json(announcements.GET(req(who.sa, "/api/announcements?manage=1")));
    expect(list.body.announcements[0]).toMatchObject({ title: "Payday", can_edit: false, can_delete: true });
    expect((await json(announcements.DELETE(req(who.sa, "/api/announcements", "DELETE", { id: hrPost.id })))).status).toBe(200);
    expect(await feed(who.ana)).toEqual([]);
  });

  it("an expired announcement leaves the normal view; over-long text is refused", async () => {
    const posted = (await post(who.hr, { title: "Enrollment", body: "Until Friday", audience: "all" })).body.announcement;
    // It ended long ago (stored as the database would hold it).
    table("branch_announcements").find((a) => a.id === posted.id).expires_on = "2020-01-01";
    expect(await feed(who.ana)).toEqual([]);
    const managed = await json(announcements.GET(req(who.hr, "/api/announcements?manage=1")));
    expect(managed.body.announcements[0]).toMatchObject({ title: "Enrollment", status: "expired" });
    expect((await post(who.hr, { title: "T".repeat(101), body: "x", audience: "all" })).status).toBe(400);
    expect((await post(who.hr, { title: "x", body: "M".repeat(1001), audience: "all" })).status).toBe(400);
    expect((await post(who.hr, { title: "", body: "x", audience: "all" })).status).toBe(400);
    expect((await post(who.hr, { title: "x", body: "y", audience: "all", expires_on: "2020-01-01" })).status).toBe(400);
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
