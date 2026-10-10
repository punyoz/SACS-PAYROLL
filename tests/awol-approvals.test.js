/**
 * AWOL cases (/api/hr/awol-cases) and Approvals (/api/admin/approvals):
 * docs/payroll-schedule-loans-awol.md §5, §6.7, §6.8. The database side
 * (payroll hold trigger, one open case, two-person adjustment rule) is tested
 * against PostgreSQL with 20261009010000.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "b-main";
const OTHER = "b-other";
const PAOLO = "u-paolo";
const FAR = "u-far";
const ANA = "u-ana";

const who = {
  hr: { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Rita HR" },
  admin: { user_id: "u-adm", role: "admin", branch_id: BRANCH, full_name: "Ada Admin" },
  otherAdmin: { user_id: "u-adm2", role: "admin", branch_id: OTHER, full_name: "Odo Admin" },
  accountant: { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" },
};

let awol;
let approvals;
let createSessionToken;
let SESSION_COOKIE;

function call(handler, path, method, body, as) {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: "s-1" });
  return handler(new Request(`https://sacs.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }));
}
const hr = (method, body) => call(awol[method], "/api/hr/awol-cases", method, body, who.hr);
const apv = (method, body, as) => call(approvals[method], "/api/admin/approvals", method, body, as);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-awol";
  resetDb();
  const emp = (id, name, code, branch) => ({ id, email: `${id}@sacs.test`, user_metadata: { role: "employee", full_name: name, employee_id: code, branch_id: branch, employee_status: "Active" } });
  users.push(emp(PAOLO, "Paolo Diaz", "SACS-010", BRANCH), emp(FAR, "Far Away", "SACS-011", OTHER), emp(ANA, "Ana Reyes", "SACS-012", BRANCH));
  table("branches").push({ id: BRANCH, name: "Main" }, { id: OTHER, name: "Other" });
  table("profiles").push(
    { id: "u-hr", branch_id: null }, { id: "u-adm", branch_id: BRANCH }, { id: "u-adm2", branch_id: OTHER }, { id: "u-acct", branch_id: BRANCH },
    { id: PAOLO, full_name: "Paolo Diaz", branch_id: BRANCH, employee_status: "Active", employee_type: "Teaching" },
    { id: FAR, full_name: "Far Away", branch_id: OTHER, employee_status: "Active", employee_type: "Teaching" },
    { id: ANA, full_name: "Ana Reyes", branch_id: BRANCH, employee_status: "Active", employee_type: "Teaching", is_licensed_teacher: true },
  );
  table("employee_awol_cases").push(
    { id: "case-paolo", employee_id: PAOLO, branch_id: BRANCH, first_absent_on: "2026-11-09", last_present_on: "2026-11-06", stage: "flagged", flagged_at: "2026-11-11T16:20:00Z", created_at: "2026-11-11T16:20:00Z" },
    { id: "case-far", employee_id: FAR, branch_id: OTHER, first_absent_on: "2026-11-09", stage: "for_decision", recommendation: "Separate: no reply to both notices", recommended_by_name: "Rita HR", flagged_at: "2026-11-11T16:20:00Z", created_at: "2026-11-11T16:20:00Z" },
  );
  table("attendance_logs").push(
    ...["2026-11-09", "2026-11-10", "2026-11-11"].map((d, i) => ({ id: `a${i}`, employee_id: PAOLO, log_date: d, status: "Absent" })),
  );

  awol = await import("@/app/api/hr/awol-cases/route");
  approvals = await import("@/app/api/admin/approvals/route");
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => { vi.useRealTimers(); });

const paolo = () => table("profiles").find((p) => p.id === PAOLO);
const theCase = () => table("employee_awol_cases").find((c) => c.id === "case-paolo");

describe("AWOL case flow", () => {
  it("HR sees the flagged case with its absences; the Accountant can read, not act", async () => {
    const body = await (await hr("GET")).json();
    const row = body.cases.find((c) => c.id === "case-paolo");
    expect(row).toMatchObject({ stage: "flagged", absent_days: 3, last_absent_on: "2026-11-11", employee_name: "Paolo Diaz" });
    expect(body.can_edit).toBe(true);
    const acct = await (await call(awol.GET, "/api/hr/awol-cases", "GET", null, who.accountant)).json();
    expect(acct.can_edit).toBe(false);
    expect(acct.cases.map((c) => c.id)).toEqual(["case-paolo"]);   // own branch only
  });

  it("confirm → AWOL in profiles and metadata, logged; steps out of order are refused", async () => {
    expect((await hr("PATCH", { case_id: "case-paolo", action: "second_notice" })).status).toBe(409);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "confirm", note: "Called him and his mother; no answer" })).status).toBe(200);
    expect(paolo().employee_status).toBe("AWOL");
    expect(users.find((u) => u.id === PAOLO).user_metadata.employee_status).toBe("AWOL");
    expect(theCase()).toMatchObject({ stage: "confirmed", confirmed_by: "u-hr", confirmed_by_name: "Rita HR" });
    expect(table("employee_status_changes")[0]).toMatchObject({ employee_id: PAOLO, old_status: "Active", new_status: "AWOL", awol_case_id: "case-paolo", changed_by: "u-hr" });
  });

  it("notices need at least 5 days to reply; then recommend → Admin approves separation", async () => {
    await hr("PATCH", { case_id: "case-paolo", action: "confirm", note: "Unreachable" });
    expect((await hr("PATCH", { case_id: "case-paolo", action: "first_notice", sent_on: "2026-11-12", reply_by: "2026-11-14" })).status).toBe(400);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "first_notice", sent_on: "2026-11-12" })).status).toBe(200);
    expect(theCase().first_notice_reply_by).toBe("2026-11-17");
    expect((await hr("PATCH", { case_id: "case-paolo", action: "second_notice", sent_on: "2026-11-18", conference_on: "2026-11-25" })).status).toBe(200);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "recommend", recommendation: "short" })).status).toBe(400);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "recommend", recommendation: "No reply to either notice; did not attend the Nov 25 conference." })).status).toBe(200);
    expect(theCase().stage).toBe("for_decision");
    // HR cannot decide; the Admin can.
    expect((await hr("PATCH", { case_id: "case-paolo", action: "approve_separation" })).status).toBe(400);
    expect((await apv("PATCH", { action: "decide_awol", case_id: "case-paolo", decision: "approve", separation_effective: "2026-12-07" }, who.hr)).status).toBe(403);

    const queue = await (await apv("GET", null, who.admin)).json();
    expect(queue.awol.map((c) => c.id)).toEqual(["case-paolo"]);   // not the other branch's case
    expect(queue.can.decide).toBe(true);
    expect((await apv("PATCH", { action: "decide_awol", case_id: "case-paolo", decision: "approve", separation_effective: "2026-12-07" }, who.admin)).status).toBe(200);
    expect(paolo()).toMatchObject({ employee_status: "Separated", separated_on: "2026-12-07" });
    expect(theCase()).toMatchObject({ stage: "closed", outcome: "separated", separation_effective: "2026-12-07", decided_by: "u-adm" });
  });

  it("the Admin can return a recommendation to HR with a reason", async () => {
    Object.assign(theCase(), { stage: "for_decision", recommendation: "Separate" });
    expect((await apv("PATCH", { action: "decide_awol", case_id: "case-paolo", decision: "return" }, who.admin)).status).toBe(400);
    expect((await apv("PATCH", { action: "decide_awol", case_id: "case-paolo", decision: "return", note: "Attach the courier receipt" }, who.admin)).status).toBe(200);
    expect(theCase().stage).toBe("second_notice");
  });

  it("an Admin cannot decide another branch's case", async () => {
    expect((await apv("PATCH", { action: "decide_awol", case_id: "case-far", decision: "approve" }, who.admin)).status).toBe(404);
    const other = await (await apv("GET", null, who.otherAdmin)).json();
    expect(other.awol.map((c) => c.id)).toEqual(["case-far"]);
  });

  it("closing as returned sets the employee back to Active (pay released)", async () => {
    await hr("PATCH", { case_id: "case-paolo", action: "confirm", note: "Unreachable" });
    expect((await hr("PATCH", { case_id: "case-paolo", action: "close", outcome: "returned", note: "ok" })).status).toBe(400);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "close", outcome: "returned", returned_on: "2026-11-12", note: "Came back; was hospitalized" })).status).toBe(200);
    expect(paolo().employee_status).toBe("Active");
    expect(theCase()).toMatchObject({ stage: "closed", outcome: "returned", returned_on: "2026-11-12" });
  });

  it("HR can open a case by hand; only one open case per employee", async () => {
    expect((await hr("POST", { employee_id: ANA, first_absent_on: "2026-12-01" })).status).toBe(400);   // future
    expect((await hr("POST", { employee_id: ANA, first_absent_on: "2026-11-10", last_present_on: "2026-11-09" })).status).toBe(200);
    expect(table("employee_awol_cases").some((c) => c.employee_id === ANA && c.stage === "flagged")).toBe(true);
  });
});

describe("Approvals: excess subsidy advances and adjustments", () => {
  beforeEach(() => {
    table("payroll_subsidy_balances").push({ id: "bal-ana", employee_id: ANA, subsidy_year_start: "2026-01-01", status: "open", annual_amount: 24000, eligible_months: 9, remaining: -2000 });
    table("payroll_loans").push({
      id: "adv-ana", employee_id: ANA, branch_id: BRANCH, loan_type: "subsidy_advance", principal: 20000, remaining_balance: 2000,
      status: "suspended", awaiting_decision: true, consent_refused_at: "2026-11-10T00:00:00Z", subsidy_balance_id: "bal-ana", status_reason: "Consent refused: will not sign",
    });
  });

  it("HR recommends, the Admin approves; a waiver closes the advance", async () => {
    expect((await apv("PATCH", { action: "approve_loan_decision", loan_id: "adv-ana" }, who.admin)).status).toBe(409);   // nothing recommended yet
    expect((await apv("PATCH", { action: "recommend_loan_decision", loan_id: "adv-ana", decision: "waive", reason: "short" }, who.hr)).status).toBe(400);
    expect((await apv("PATCH", { action: "recommend_loan_decision", loan_id: "adv-ana", decision: "waive", reason: "Hardship; amount small" }, who.admin)).status).toBe(403);
    expect((await apv("PATCH", { action: "recommend_loan_decision", loan_id: "adv-ana", decision: "waive", reason: "Hardship; amount small" }, who.hr)).status).toBe(200);
    const queue = await (await apv("GET", null, who.admin)).json();
    expect(queue.loan_decisions[0]).toMatchObject({ excess: 2000, decision: "waive", decision_recommended_by: "u-hr" });
    expect((await apv("PATCH", { action: "approve_loan_decision", loan_id: "adv-ana" }, who.hr)).status).toBe(403);
    expect((await apv("PATCH", { action: "approve_loan_decision", loan_id: "adv-ana", note: "OK" }, who.admin)).status).toBe(200);
    expect(table("payroll_loans")[0]).toMatchObject({ decision_approved_by: "u-adm" });
    expect(table("payroll_loan_payments")[0]).toMatchObject({ loan_id: "adv-ana", kind: "waiver", amount: 2000 });
  });

  it("the Accountant requests an adjustment; the Admin approves or rejects (with a reason)", async () => {
    const req = (body) => apv("POST", { action: "request_adjustment", subsidy_balance_id: "bal-ana", months_missed: 1, months_label: "Jul 2026", amount: 2000, reason: "Verified late; license valid since Jul 2", ...body }, who.accountant);
    expect((await req({ reason: "late" })).status).toBe(400);
    expect((await req({ months_missed: 13 })).status).toBe(400);
    expect((await req()).status).toBe(200);
    const row = table("payroll_subsidy_adjustments")[0];
    expect(row).toMatchObject({ status: "pending", requested_by: "u-acct", amount: 2000 });
    expect((await apv("PATCH", { action: "decide_adjustment", adjustment_id: row.id, decision: "approve" }, who.accountant)).status).toBe(403);
    expect((await apv("PATCH", { action: "decide_adjustment", adjustment_id: row.id, decision: "reject" }, who.admin)).status).toBe(400);
    expect((await apv("PATCH", { action: "decide_adjustment", adjustment_id: row.id, decision: "approve" }, who.admin)).status).toBe(200);
    expect(row).toMatchObject({ status: "approved", decided_by: "u-adm", decided_by_role: "admin" });
    expect((await apv("PATCH", { action: "decide_adjustment", adjustment_id: row.id, decision: "approve" }, who.admin)).status).toBe(409);
  });

  it("each role sees its own queues", async () => {
    const asHr = await (await apv("GET", null, who.hr)).json();
    expect(asHr.adjustments).toEqual([]);
    expect(asHr.can).toMatchObject({ recommend: true, decide: false });
    const asAcct = await (await apv("GET", null, who.accountant)).json();
    expect(asAcct.awol).toEqual([]);
    expect(asAcct.can.request).toBe(true);
    expect(asAcct.balances.map((b) => b.id)).toEqual(["bal-ana"]);
  });
});
