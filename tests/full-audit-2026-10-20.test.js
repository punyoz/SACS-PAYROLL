/**
 * Full audit, 2026-10-20: one status vocabulary everywhere, the bell is
 * written for real events (so it survives a refresh), and HR no longer
 * lists the Super Admin and Admin accounts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { RUN_STATUS_LABELS } from "@/lib/payroll/runs";
import { recordStatusMeta, statusMeta } from "@/lib/portal/payroll-preview";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SA = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "11111111-0000-4000-8000-0000000000a1";
const HR = "22222222-0000-4000-8000-000000000001";
const ACCT = "22222222-0000-4000-8000-0000000000c1";
const ANA = "33333333-0000-4000-8000-0000000000a1";
const later = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

const who = {
  hr: { user_id: HR, role: "hr", branch_id: null, full_name: "Hana HR" },
  ana: { user_id: ANA, role: "employee", branch_id: A, full_name: "Ana Reyes" },
};

let createSessionToken;
let SESSION_COOKIE;

function req(as, path, method = "GET", body = null) {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: `s-${as.user_id}` });
  const request = new Request(`https://sacs.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  request.nextUrl = new URL(request.url);
  return request;
}
const json = async (p) => { const r = await p; return { status: r.status, body: await r.json().catch(() => ({})) }; };

describe("one set of payroll status labels", () => {
  it("runs use exactly the four payroll labels", () => {
    expect(RUN_STATUS_LABELS).toEqual({ draft: "Not submitted to HR", pending: "Pending HR Approval", approved: "Paid", rejected: "Rejected by HR" });
  });

  it("records say the same, before and after HR's decision", () => {
    const period = "October 1-15, 2026";
    expect(recordStatusMeta({ status: "draft", pay_period: period }).label).toBe("Not submitted to HR");
    expect(recordStatusMeta({ status: "paid", pay_period: period, run_status: null }).label).toBe("Not submitted to HR");
    expect(recordStatusMeta({ status: "paid", pay_period: period, run_status: "pending" }).label).toBe("Pending HR Approval");
    expect(recordStatusMeta({ status: "paid", pay_period: period, run_status: "rejected" }).label).toBe("Rejected by HR");
    expect(recordStatusMeta({ status: "paid", pay_period: period, run_status: "approved" }).label).toBe("Paid");
    // Before approval existed (pre-October 2026) the same words are used.
    expect(statusMeta("draft").label).toBe("Not submitted to HR");
    expect(statusMeta("pending").label).toBe("Pending HR Approval");
    expect(statusMeta("rejected").label).toBe("Rejected by HR");
    expect(statusMeta("paid").label).toBe("Paid");
  });
});

describe("the bell is written for real events", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-full-audit";
    resetDb();
    table("branches").push({ id: A, name: "Main", status: "active" });
    table("profiles").push(
      { id: HR, role: "hr", branch_id: null, full_name: "Hana HR", archived: false },
      { id: ANA, role: "employee", branch_id: A, full_name: "Ana Reyes", employee_id: "SACS-001", archived: false, position: "Teacher I" },
    );
    users.push(
      { id: ANA, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Reyes", branch_id: A } },
      { id: HR, email: "hr@sacs.test", user_metadata: { role: "hr", full_name: "Hana HR" } },
    );
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("a filed leave tells HR; HR's decision tells the employee", async () => {
    const employeeRoute = await import("@/app/api/employee/leave-requests/route");
    const hrRoute = await import("@/app/api/hr/leave-requests/route");
    const filed = await json(employeeRoute.POST(req(who.ana, "/api/employee/leave-requests", "POST", {
      leave_type: "Vacation Leave", start_date: later(10), end_date: later(10), reason: "Family event", pay_status: "with_pay",
    })));
    expect(filed.status).toBe(201);
    expect(table("notifications")).toEqual([expect.objectContaining({ recipient_id: HR, kind: "leave_filed", link_page: "hr-leaves" })]);

    const decided = await json(hrRoute.PATCH(req(who.hr, "/api/hr/leave-requests", "PATCH", { id: filed.body.request.id, action: "approve" })));
    expect(decided.status).toBe(200);
    expect(table("notifications").filter((n) => n.recipient_id === ANA)).toEqual([
      expect.objectContaining({ kind: "leave_approved", title: "Your leave was approved", link_page: "emp-leave" }),
    ]);

    // Stored, so the bell shows it after a refresh.
    const bell = await import("@/app/api/notifications/route");
    const mine = await json(bell.GET(req(who.ana, "/api/notifications")));
    expect(mine.body.notifications.map((n) => n.kind)).toEqual(["leave_approved"]);
    expect(mine.body.unread).toBe(1);
  });
});

describe("HR's user list", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-full-audit";
    resetDb();
    table("branches").push({ id: A, name: "Main", status: "active" });
    const people = [[SA, "super_admin", null], [ADMIN, "admin", A], [HR, "hr", null], [ACCT, "accountant", A], [ANA, "employee", A]];
    for (const [id, role, branch] of people) {
      table("profiles").push({ id, role, branch_id: branch, full_name: `${role} person`, email: `${role}@sacs.test`, archived: false });
      users.push({ id, email: `${role}@sacs.test`, user_metadata: { role, full_name: `${role} person`, branch_id: branch } });
    }
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("lists only the Employee and Accountant accounts HR manages", async () => {
    const route = await import("@/app/api/admin/users/route");
    const listed = await json(route.GET(req(who.hr, "/api/admin/users")));
    expect(listed.status).toBe(200);
    expect(listed.body.users.map((u) => u.role).sort()).toEqual(["accountant", "employee"]);
  });
});

describe("Organization name (System Configuration)", () => {
  it("is cleaned to one short line, and defaults to SACS", async () => {
    const { normalizeOrgName, systemName } = await import("@/lib/org-name-format");
    expect(normalizeOrgName("  Shepherd   Angels \n")).toBe("Shepherd Angels");
    expect(normalizeOrgName('<script>"x"')).toBe("script x");
    expect(normalizeOrgName("")).toBe("SACS");
    expect(normalizeOrgName("x".repeat(80))).toHaveLength(60);
    expect(systemName("SACS")).toBe("SACS Payroll");
  });

  it("names the code email (subject, sender, footer) and the payslip PDF", async () => {
    const { buildOtpEmail } = await import("@/lib/mail/otp-email");
    const mail = buildOtpEmail({ code: "042917", purpose: "login", minutes: 5, orgName: "SAC Antipolo" });
    expect(mail.subject).toBe("Your SAC Antipolo Payroll sign-in code");
    expect(mail.fromName).toBe("SAC Antipolo Payroll");
    expect(mail.html).toContain("Sent automatically by SAC Antipolo Payroll.");
    // Unchanged when nothing is set: what live sends today.
    expect(buildOtpEmail({ code: "042917", purpose: "reset", minutes: 5 }).subject).toBe("Your SACS Payroll password reset code");

    const { buildPayslipPdf } = await import("@/lib/payroll/payslip-pdf");
    const details = { status: "final", payslip_no: "PS-1", pay_period: "October 1-15, 2026", employee: { name: "Ana", id: "1", branch: "Main", position: "Teacher" }, net_pay: 1 };
    expect(buildPayslipPdf(details, { orgName: "SAC Antipolo" }).toString("latin1")).toContain("Payslip - SAC Antipolo Payroll Management System");
    expect(buildPayslipPdf(details).toString("latin1")).toContain("Payslip - SACS Payroll Management System");
  });

  it("reaches every portal's header through /api/rbac/me", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-full-audit";
    resetDb();
    table("system_config").push({ section: "general", key: "org_name", value: "SAC Antipolo" });
    table("profiles").push({ id: ANA, role: "employee", branch_id: A, full_name: "Ana Reyes", archived: false });
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
    const me = await import("@/app/api/rbac/me/route");
    const res = await json(me.GET(req(who.ana, "/api/rbac/me")));
    expect(res.status).toBe(200);
    expect(res.body.org_name).toBe("SAC Antipolo");
  });
});
