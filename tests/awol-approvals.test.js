/**
 * AWOL cases (/api/hr/awol-cases) and Approvals (/api/admin/approvals):
 * docs/payroll-schedule-loans-awol.md §5, §6.7, §6.8. The database side
 * (payroll hold trigger, one open case, two-person adjustment rule) is tested
 * against PostgreSQL with 20261009010000.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";

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

  it("notices need at least 5 days to reply", async () => {
    await hr("PATCH", { case_id: "case-paolo", action: "confirm", note: "Unreachable" });
    expect((await hr("PATCH", { case_id: "case-paolo", action: "first_notice", sent_on: "2026-11-12", reply_by: "2026-11-14" })).status).toBe(400);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "first_notice", sent_on: "2026-11-12" })).status).toBe(200);
    expect(theCase().first_notice_reply_by).toBe("2026-11-17");
    expect((await hr("PATCH", { case_id: "case-paolo", action: "second_notice", sent_on: "2026-11-18", conference_on: "2026-11-25" })).status).toBe(200);
    expect(theCase().stage).toBe("second_notice");
  });

  it("there is no Admin approval step: no recommend, no Admin decision, no Admin queue", async () => {
    Object.assign(theCase(), { stage: "second_notice" });
    expect((await hr("PATCH", { case_id: "case-paolo", action: "recommend", recommendation: "No reply to either notice; did not attend the conference." })).status).toBe(400);
    expect((await call(awol.PATCH, "/api/hr/awol-cases", "PATCH", { case_id: "case-paolo", action: "separate", separation_effective: "2026-12-07", grounds: "No reply to either notice." }, who.admin)).status).toBe(403);
    // The Admin has no Approvals page at all since 2026-10-20.
    expect((await apv("PATCH", { action: "decide_awol", case_id: "case-paolo", decision: "approve", separation_effective: "2026-12-07" }, who.admin)).status).toBe(403);
    expect((await apv("GET", null, who.admin)).status).toBe(403);
    expect(theCase().stage).toBe("second_notice");
    expect(paolo().employee_status).toBe("Active");
  });

  it("HR separates after both notices, with no Admin approval", async () => {
    await hr("PATCH", { case_id: "case-paolo", action: "confirm", note: "Unreachable" });
    // Not before the 2nd notice.
    expect((await hr("PATCH", { case_id: "case-paolo", action: "separate", separation_effective: "2026-12-07", grounds: "No reply to either notice." })).status).toBe(409);
    await hr("PATCH", { case_id: "case-paolo", action: "first_notice", sent_on: "2026-11-12" });
    await hr("PATCH", { case_id: "case-paolo", action: "second_notice", sent_on: "2026-11-18" });
    expect((await hr("PATCH", { case_id: "case-paolo", action: "separate", separation_effective: "2026-12-07", grounds: "short" })).status).toBe(400);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "separate", separation_effective: "2026-11-01", grounds: "No reply to either notice." })).status).toBe(400);
    expect((await hr("PATCH", { case_id: "case-paolo", action: "separate", separation_effective: "2026-12-07", grounds: "No reply to either notice; missed the conference." })).status).toBe(200);
    expect(paolo()).toMatchObject({ employee_status: "Separated", separated_on: "2026-12-07" });
    expect(theCase()).toMatchObject({ stage: "closed", outcome: "separated", separation_effective: "2026-12-07", decided_by: "u-hr" });
  });

  it("HR can decide a case that was already sent to the Admin", async () => {
    Object.assign(theCase(), { stage: "for_decision", recommendation: "Separate" });
    expect((await hr("PATCH", { case_id: "case-paolo", action: "separate", separation_effective: "2026-12-07", grounds: "No reply to either notice." })).status).toBe(200);
    expect(theCase()).toMatchObject({ stage: "closed", outcome: "separated", decided_by: "u-hr", recommendation: "Separate" });
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

// 2026-10-21: the Accountant processes, HR approves (20261021010000). The
// database functions own the rules (scripts/checks/subsidy-processing-scenarios.sql);
// here: who reaches which step, and what the routes send them.
describe("Subsidies: the Accountant processes, HR approves", () => {
  const BAL = "bbbbbbbb-1111-4111-8111-000000000001";
  const REQ = "cccccccc-1111-4111-8111-000000000001";

  beforeEach(() => {
    table("payroll_subsidy_balances").push({ id: BAL, employee_id: ANA, subsidy_year_start: "2026-01-01", status: "open", annual_amount: 24000,
      eligible_months: 9, entitlement: 18000, advances_total: 0, paid_out: 0, remaining: 18000, advance_limit: "full_year", eligible_from: "2026-04-01" });
    rpc.results.subsidy_requests_raise_excess = () => ({ data: 0, error: null });
    rpc.results.subsidy_request_process = ({ p_actor, p_request_id, p_kind, p_employee_id, p_balance_id, p_amount, p_reason, p_details }) => {
      const row = table("payroll_subsidy_requests").find((r) => r.id === p_request_id);
      if (row) {
        Object.assign(row, { status: "processed", amount: p_amount, reason: p_reason, details: p_details, submission_no: row.submission_no + 1, processed_by: p_actor, processed_by_name: "Ana Accountant", decided_by: null });
        row.history.push({ action: "resubmitted", actor_name: "Ana Accountant", at: "2026-11-03T00:00:00Z", note: p_reason });
        return { data: row, error: null };
      }
      const created = { id: REQ, kind: p_kind, employee_id: p_employee_id, subsidy_balance_id: p_balance_id, status: "processed", amount: p_amount, reason: p_reason, details: p_details,
        submission_no: 1, requested_by: p_actor, requested_by_name: "Ana Accountant", requested_at: "2026-11-01T00:00:00Z",
        processed_by: p_actor, processed_by_name: "Ana Accountant", processed_at: "2026-11-01T00:00:00Z",
        history: [{ action: "processed", actor_name: "Ana Accountant", at: "2026-11-01T00:00:00Z", note: p_reason }] };
      table("payroll_subsidy_requests").push(created);
      return { data: created, error: null };
    };
    rpc.results.subsidy_request_decide = ({ p_actor, p_request_id, p_decision, p_note }) => {
      const row = table("payroll_subsidy_requests").find((r) => r.id === p_request_id);
      if (row.status !== "processed") return { data: null, error: { message: `invalid_transition: this request is ${row.status} (only a processed one is decided).` } };
      const at = new Date(Date.UTC(2026, 10, 2, row.history.length)).toISOString();
      Object.assign(row, { status: p_decision === "approve" ? "approved" : "rejected", decided_by: p_actor, decided_by_name: "Rita HR", decided_at: at, decision_note: p_note });
      row.history.push({ action: p_decision === "approve" ? "approved" : "rejected", actor_name: "Rita HR", at, note: p_note });
      return { data: row, error: null };
    };
  });

  const process = (as, body = {}) => apv("POST", { action: "process", kind: "adjustment", subsidy_balance_id: BAL, amount: 2000,
    reason: "Verified late; license valid since Jul 2", details: { months_missed: 1, months_label: "Jul 2026" }, ...body }, as);

  it("only the Accountant processes; the request goes to the database as the signed-in Accountant", async () => {
    expect((await process(who.hr)).status).toBe(403);
    expect((await process(who.admin)).status).toBe(403);
    expect((await process(who.accountant)).status).toBe(200);
    const call = rpc.calls.find((c) => c.fn === "subsidy_request_process");
    expect(call.args).toMatchObject({ p_actor: "u-acct", p_kind: "adjustment", p_employee_id: ANA, p_amount: 2000, p_details: { months_missed: 1, months_label: "Jul 2026" } });
    // The old name still works for the adjustment form.
    expect((await apv("POST", { action: "request_adjustment", subsidy_balance_id: BAL, months_missed: 1, months_label: "Jul 2026", amount: 2000, reason: "Verified late; license valid since Jul 2" }, who.accountant)).status).toBe(200);
  });

  it("only HR decides; a rejection goes back to the Accountant, who resubmits; then HR approves", async () => {
    await process(who.accountant);
    const decide = (as, decision, note) => apv("PATCH", { action: "decide", request_id: REQ, decision, note }, as);
    expect((await decide(who.accountant, "approve")).status).toBe(403);
    expect((await decide(who.admin, "approve")).status).toBe(403);
    // The one-step decisions are gone.
    expect((await apv("PATCH", { action: "decide_adjustment", adjustment_id: REQ, decision: "approve" }, who.hr)).status).toBe(409);
    expect((await decide(who.hr, "reject", "Attach the PRC receipt date.")).status).toBe(200);
    expect(rpc.calls.find((c) => c.fn === "subsidy_request_decide").args).toMatchObject({ p_actor: "u-hr", p_decision: "reject", p_note: "Attach the PRC receipt date." });
    expect((await decide(who.hr, "approve")).status).toBe(409);   // rejected: the database refuses until resubmitted
    expect((await process(who.accountant, { request_id: REQ, reason: "PRC receipt dated Jul 2, 2026" })).status).toBe(200);
    expect((await decide(who.hr, "approve")).status).toBe(200);

    const asHr = await (await apv("GET", null, who.hr)).json();
    expect(asHr.can).toEqual({ process: false, decide: true });
    expect(asHr.requests).toEqual([expect.objectContaining({ id: REQ, status: "approved", status_label: "Approved", processed_by_name: "Ana Accountant", decided_by_name: "Rita HR" })]);
    // Both decisions stay in the history, with who processed each round.
    expect(asHr.history.map((h) => [h.decision, h.processed_by_name, h.decided_by_name])).toEqual([
      ["approved", "Ana Accountant", "Rita HR"], ["rejected", "Ana Accountant", "Rita HR"],
    ]);
  });

  it("a database refusal reaches the person as it is", async () => {
    rpc.results.subsidy_request_process = () => ({ data: null, error: { message: "forbidden: you cannot process your own subsidy." } });
    const res = await process(who.accountant);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You cannot process your own subsidy.");
  });

  it("each role sees what it owns; the Admin has no access", async () => {
    const asAcct = await (await apv("GET", null, who.accountant)).json();
    expect(asAcct.can).toEqual({ process: true, decide: false });
    expect(asAcct.balances.map((b) => b.id)).toEqual([BAL]);
    expect((await apv("GET", null, who.admin)).status).toBe(403);
  });
});
