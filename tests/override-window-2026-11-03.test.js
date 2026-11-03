/**
 * Attendance overrides only during the processing window (2026-11-03,
 * src/lib/payroll/override-window.js): Absent / Late / Undertime / Half day /
 * Perfect attendance may differ from the RFID-derived values only
 *   - inside the period's processing window (the payslip schedule's
 *     generation window), or on a run HR rejected (that run only);
 *   - on a payroll still open (no Final payslip; run not Pending / Approved);
 *   - for an employee of the Accountant's own branch.
 * The API refuses everything else (403) and logs the attempt
 * (audit_logs action "attendance_override_blocked").
 *
 * Route cases use September 16-30, 2026 with no payslip schedule saved: the
 * window is Sep 30 (the period's last day) to the pay date, Oct 5.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import {
  attendanceOverrideState,
  attendanceOverrides,
  insideProcessingWindow,
  processingWindowLabel,
  processingWindowRange,
} from "@/lib/payroll/override-window";
import { createPayslipSchedule } from "@/lib/payroll/schedule";
import { generationWindow } from "@/lib/payroll/generation-window";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const scheduled = (startKey, endKey, today, holidays = []) => {
  const schedule = createPayslipSchedule({ settings: [], holidays });
  return generationWindow({ start_key: startKey, end_key: endKey, label: "p" }, { today, schedule: schedule.forPeriod(startKey) });
};

describe("The processing window (payslip schedule)", () => {
  it("Nov 1-15, 2026: Sun Nov 15 moves to Mon Nov 16, open five days", () => {
    const win = scheduled("2026-11-01", "2026-11-15", "2026-11-03");
    expect(processingWindowRange(win)).toEqual({ opens_on: "2026-11-16", closes_on: "2026-11-20" });
    expect(processingWindowLabel(win)).toBe("Nov 16 to Nov 20");
    expect(insideProcessingWindow(win)).toBe(false);
    expect(insideProcessingWindow(win, "2026-11-16")).toBe(true);
    expect(insideProcessingWindow(win, "2026-11-20")).toBe(true);
    expect(insideProcessingWindow(win, "2026-11-21")).toBe(false);
  });

  it("crosses the year boundary (Dec 2026 -> Jan 2027) and nothing is fixed to 2026", () => {
    const holidays = [{ holiday_date: "2026-12-30" }, { holiday_date: "2026-12-31" }];
    const win = scheduled("2026-12-16", "2026-12-31", "2027-01-02", holidays);
    // Dec 31 and Dec 30 are holidays: the 2nd half moves back to Tue Dec 29.
    expect(processingWindowRange(win)).toEqual({ opens_on: "2026-12-29", closes_on: "2027-01-02" });
    expect(processingWindowLabel(win)).toBe("Dec 29, 2026 to Jan 2, 2027");
    expect(insideProcessingWindow(win, "2027-01-02")).toBe(true);
    expect(insideProcessingWindow(win, "2027-01-03")).toBe(false);
    expect(attendanceOverrideState({ window: win, today: "2027-01-01" }).allowed).toBe(true);
    expect(attendanceOverrideState({ window: win, today: "2027-01-03" }).code).toBe("override_outside_window");

    // January 2027 and December 2027 follow the same rule from their own dates.
    expect(processingWindowRange(scheduled("2027-01-01", "2027-01-15", "2027-01-10"))).toEqual({ opens_on: "2027-01-15", closes_on: "2027-01-19" });
    expect(processingWindowRange(scheduled("2027-12-16", "2027-12-31", "2027-12-01"))).toEqual({ opens_on: "2027-12-31", closes_on: "2028-01-04" });
  });

  it("follows a saved schedule version (effective-dated, any year)", () => {
    const schedule = createPayslipSchedule({ settings: [{ id: "v", effective_from: "2027-01-01", first_half_day: 14, window_days: 3 }] });
    const win = generationWindow({ start_key: "2027-03-01", end_key: "2027-03-15" }, { today: "2027-03-16", schedule: schedule.forPeriod("2027-03-01") });
    expect(processingWindowRange(win)).toEqual({ opens_on: "2027-03-15", closes_on: "2027-03-17" });
    expect(attendanceOverrideState({ window: win }).allowed).toBe(true);
  });
});

describe("attendanceOverrideState", () => {
  const win = scheduled("2026-11-01", "2026-11-15", "2026-11-17");
  const at = (today) => ({ ...win, today });

  it("inside the window on an open payroll: allowed", () => {
    expect(attendanceOverrideState({ window: win })).toMatchObject({ allowed: true, code: null, reopened: false });
  });
  it("before it opens and after it closes: locked, with the window in the message", () => {
    const before = attendanceOverrideState({ window: at("2026-11-15") });
    expect(before).toMatchObject({ allowed: false, code: "override_outside_window" });
    expect(before.message).toBe("Overrides are only available during the processing window (Nov 16 to Nov 20).");
    expect(attendanceOverrideState({ window: at("2026-11-21") }).allowed).toBe(false);
  });
  it("submitted to HR, approved, or a Final payslip: locked", () => {
    expect(attendanceOverrideState({ window: win, runStatus: "pending" }).code).toBe("override_run_submitted");
    expect(attendanceOverrideState({ window: win, runStatus: "approved" }).code).toBe("override_run_approved");
    expect(attendanceOverrideState({ window: win, runStatus: "draft", payslipStatus: "final" }).code).toBe("override_payslip_final");
  });
  it("HR rejected the run: reopened for that run, on any date", () => {
    expect(attendanceOverrideState({ window: at("2026-12-20"), runStatus: "rejected", payslipStatus: "final" })).toMatchObject({ allowed: true, reopened: true });
  });
  it("another branch's employee: locked", () => {
    expect(attendanceOverrideState({ window: win, sameBranch: false }).code).toBe("override_other_branch");
  });
  it("picks the attendance fields (Leave without pay included, 2026-11-03) out of a payroll's deviations", () => {
    expect(attendanceOverrides([{ field: "absences_days" }, { field: "leave_without_pay_days" }, { field: "perfect_attendance" }]).map((d) => d.field))
      .toEqual(["absences_days", "leave_without_pay_days", "perfect_attendance"]);
  });
});

/* ── Direct API calls ──────────────────────────────────────────────────── */

const BRANCH = "branch-a";
const OTHER = "branch-b";
const EMP = "u-emp";
const PERIOD = "September 16-30, 2026";
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };
const OTHER_ACCOUNTANT = { user_id: "u-acct-b", role: "accountant", branch_id: OTHER, full_name: "Ben Accountant" };

const log = (id, date, fields = {}) => ({
  id, employee_id: EMP, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`, created_at: `${date}T00:00:00Z`,
  status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false, ...fields,
});
const rate = (rateType, value) => ({ id: `cfg-${rateType}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" });

let POST;
let PATCH;
let createSessionToken;
let SESSION_COOKIE;

function request(who, method, body) {
  const token = createSessionToken({ ...who, email: `${who.user_id}@sacs.test`, session_id: "s-1" });
  return new Request("https://sacs.test/api/accountant/payroll", {
    method, headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, body: JSON.stringify(body),
  });
}

/** The Single Entry form's body, with one day's absence overridden (computed: 0). */
const formBody = (action, { absences = 1, reason = "RFID reader was down; confirmed absent" } = {}) => ({
  action, employee_id: EMP, pay_period: PERIOD,
  deductions: { absences_days: absences, late_days: 0, undertime_minutes: 0, half_days: 0, leave_with_pay_days: 0, leave_without_pay_days: 0 },
  override_reason: reason,
});

async function call(on, method, body, who = ACCOUNTANT) {
  vi.setSystemTime(new Date(`${on}T10:00:00+08:00`));
  const handler = method === "POST" ? POST : PATCH;
  const response = await handler(request(who, method, body));
  return { status: response.status, body: await response.json() };
}

const blockedLogs = () => table("audit_logs").filter((row) => row.action === "attendance_override_blocked");
const entry = () => table("payroll_entries").find((row) => row.employee_id === EMP && row.pay_period === PERIOD);
const pushRun = (status) => table("payroll_runs").push({
  id: "run-1", branch_id: BRANCH, period_label: PERIOD, period_start: "2026-09-16", period_end: "2026-09-30",
  cutoff_type: "second", status, run_no: 1, submission_no: 1, created_at: "2026-10-01T00:00:00Z",
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-override-window";
  resetDb();
  users.push({
    id: EMP, email: "emp@sacs.test",
    user_metadata: { role: "employee", full_name: "Emma Employee", employee_id: "SACS-001", basic_salary: 20000, branch_id: BRANCH, position: "Teacher I" },
  });
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH },
    { id: "u-acct-b", branch_id: OTHER },
    { id: EMP, full_name: "Emma Employee", email: "emp@sacs.test", branch_id: BRANCH },
  );
  table("branches").push({ id: BRANCH, name: "Main Branch" }, { id: OTHER, name: "Other Branch" });
  table("payroll_rate_configs").push(
    rate("hourly", 60), rate("daily", 500), rate("half_day_pct", 50), rate("absent_pct", 100),
    rate("late_days_per_absent", 3), rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0),
    rate("perfect_attendance_bonus", 0), rate("sss_pct", 2), rate("philhealth_pct", 2), rate("pagibig_pct", 2),
  );
  table("attendance_logs").push(log("ok-1", "2026-09-16"));
  ({ POST, PATCH } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => { vi.useRealTimers(); });

describe("API: inside the window", () => {
  it("an override with a reason is saved and logged with the deviation", async () => {
    const result = await call("2026-10-01", "POST", formBody("save_draft"));
    expect(result.status).toBe(200);
    expect(entry().payroll.audit.deviations).toMatchObject({ reason: "RFID reader was down; confirmed absent", items: [{ field: "absences_days", default: 0, value: 1 }] });
    const saved = table("audit_logs").find((row) => row.action === "draft");
    expect(saved.metadata.deviations).toEqual([{ field: "absences_days", default: 0, value: 1 }]);
    expect(blockedLogs()).toHaveLength(0);
  });
  it("an override without a reason is still refused on processing", async () => {
    const result = await call("2026-10-01", "POST", formBody("submit", { reason: "" }));
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("override_reason_required");
  });
});

describe("API: locked cases are refused and logged", () => {
  it("before the window opens", async () => {
    const result = await call("2026-09-29", "POST", formBody("save_draft"));
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: "override_outside_window", error: "Overrides are only available during the processing window (Sep 30 to Oct 5)." });
    expect(entry()).toBeUndefined();
    expect(blockedLogs()).toHaveLength(1);
    expect(blockedLogs()[0]).toMatchObject({ status: "failed", actor_name: "Ana Accountant", metadata: { employee_id: EMP, pay_period: PERIOD, code: "override_outside_window", fields: ["Absent"] } });
  });
  it("after it closes (submit, late processing)", async () => {
    const result = await call("2026-10-06", "POST", formBody("submit"));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("override_outside_window");
    expect(entry()).toBeUndefined();
    expect(blockedLogs()).toHaveLength(1);
  });
  it("outside the window WITHOUT an override nothing changes: the draft saves", async () => {
    const result = await call("2026-09-29", "POST", formBody("save_draft", { absences: 0, reason: "" }));
    expect(result.status).toBe(200);
    expect(blockedLogs()).toHaveLength(0);
  });
  it("after submission to HR (run Pending)", async () => {
    pushRun("pending");
    const result = await call("2026-10-01", "POST", formBody("save_draft"));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("override_run_submitted");
    expect(blockedLogs()).toHaveLength(1);
  });
  it("after HR approval, on a finalized period", async () => {
    expect((await call("2026-10-01", "PATCH", { action: "generate", employee_id: EMP, pay_period: PERIOD })).status).toBe(200);
    pushRun("approved");
    entry().run_id = "run-1";
    const viaForm = await call("2026-10-20", "POST", formBody("submit"));
    expect(viaForm.status).toBe(403);
    expect(viaForm.body.code).toBe("override_run_approved");
    const viaReprocess = await call("2026-10-20", "PATCH", { action: "generate", reprocess: true, employee_id: EMP, pay_period: PERIOD, deductions: { absences_days: 2 }, override_reason: "Trying to change it later" });
    expect(viaReprocess.status).toBe(409);
    expect(entry().payroll.deductions.absences_days).toBe(0);
  });
  it("on a Final payslip in a run not yet submitted", async () => {
    expect((await call("2026-10-01", "PATCH", { action: "generate", employee_id: EMP, pay_period: PERIOD })).status).toBe(200);
    const viaForm = await call("2026-10-01", "POST", formBody("submit"));
    expect(viaForm.status).toBe(403);
    expect(viaForm.body.code).toBe("override_payslip_final");
    const viaReprocess = await call("2026-10-02", "PATCH", { action: "generate", reprocess: true, employee_id: EMP, pay_period: PERIOD, deductions: { absences_days: 1 }, override_reason: "Correcting the absence count" });
    expect(viaReprocess.status).toBe(403);
    expect(viaReprocess.body.code).toBe("override_payslip_final");
    expect(entry().payroll.deductions.absences_days).toBe(0);
    expect(blockedLogs()).toHaveLength(2);
    // Reprocess without an override still works as before.
    expect((await call("2026-10-02", "PATCH", { action: "generate", reprocess: true, employee_id: EMP, pay_period: PERIOD })).status).toBe(200);
  });
  it("an Accountant of another branch", async () => {
    const result = await call("2026-10-01", "POST", formBody("save_draft"), OTHER_ACCOUNTANT);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("override_other_branch");
    expect(blockedLogs()[0]).toMatchObject({ actor_name: "Ben Accountant", metadata: { employee_id: EMP, code: "override_other_branch" } });
    expect(entry()).toBeUndefined();
  });
});

describe("API: HR rejects the run -> overrides reopen for that run only", () => {
  it("the Final payslip is reprocessed with the override, after the window, and logged", async () => {
    expect((await call("2026-10-01", "PATCH", { action: "generate", employee_id: EMP, pay_period: PERIOD })).status).toBe(200);
    pushRun("rejected");
    entry().run_id = "run-1";
    const noReason = await call("2026-10-12", "PATCH", { action: "generate", reprocess: true, employee_id: EMP, pay_period: PERIOD, deductions: { absences_days: 1 }, override_reason: "" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("override_reason_required");
    const result = await call("2026-10-12", "PATCH", { action: "generate", reprocess: true, employee_id: EMP, pay_period: PERIOD, deductions: { absences_days: 1 }, override_reason: "HR: Sep 22 was an absence" });
    expect(result.status).toBe(200);
    expect(entry().payroll.deductions.absences_days).toBe(1);
    expect(entry().payroll.audit.deviations).toMatchObject({ reason: "HR: Sep 22 was an absence", items: [{ field: "absences_days", default: 0, value: 1 }] });
    const lines = entry().payroll.audit.lines.deductions.filter((line) => line.is_override);
    expect(lines).toEqual([expect.objectContaining({ type: "absent", quantity: 1, note: "HR: Sep 22 was an absence" })]);
    const logged = table("audit_logs").find((row) => row.action === "payslip_reprocess");
    expect(logged.metadata).toMatchObject({ override_reason: "HR: Sep 22 was an absence" });
  });
  it("another period's run is not reopened by it", async () => {
    pushRun("rejected");
    table("payroll_runs")[0].period_label = "September 1-15, 2026";
    const result = await call("2026-10-12", "POST", formBody("submit"));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("override_outside_window");
  });
});

/* Decision 2026-11-03: Leave without pay follows the window too (it deducts
   at the daily rate like an absence), in the single form and the batch. */
describe("API: Leave without pay is an attendance override", () => {
  const lwopBody = (action, lwop, reason = "Unfiled leave confirmed by HR") => ({
    action, employee_id: EMP, pay_period: PERIOD,
    deductions: { absences_days: 0, late_days: 0, undertime_minutes: 0, half_days: 0, leave_with_pay_days: 0, leave_without_pay_days: lwop },
    override_reason: reason,
  });
  const batch = (on, lwop, reason = "Unfiled leave confirmed by HR") => call(on, "POST", {
    action: "batch_submit", pay_period: PERIOD, override_reason: reason,
    entries: [{ employee_id: EMP, deductions: { leave_without_pay_days: lwop } }],
  });

  it("single form: refused before the window, allowed inside it with a reason", async () => {
    const before = await call("2026-09-29", "POST", lwopBody("save_draft", 1));
    expect(before.status).toBe(403);
    expect(before.body.code).toBe("override_outside_window");
    expect(blockedLogs()[0].metadata.fields).toEqual(["Leave Without Pay"]);
    const inside = await call("2026-10-01", "POST", lwopBody("save_draft", 1));
    expect(inside.status).toBe(200);
    expect(entry().payroll.audit.deviations.items).toEqual([{ field: "leave_without_pay_days", default: 0, value: 1 }]);
  });

  it("batch: after the window the employee is skipped and the attempt logged", async () => {
    const result = await batch("2026-10-06", 1);
    expect(result.status).toBe(200);
    expect(result.body.processed).toHaveLength(0);
    expect(result.body.skipped[0]).toMatchObject({ employee_id: EMP, code: "override_outside_window" });
    expect(entry()).toBeUndefined();
    expect(blockedLogs()).toHaveLength(1);
  });

  it("batch: inside the window it is processed with the reason; without a change nothing is gated", async () => {
    const inside = await batch("2026-10-01", 1);
    expect(inside.body.processed).toHaveLength(1);
    expect(entry().payroll.deductions.leave_without_pay_days).toBe(1);
    expect(entry().payroll.audit.deviations.reason).toBe("Unfiled leave confirmed by HR");
  });

  it("batch: the computed value after the window is late processing as before, not an override", async () => {
    const result = await batch("2026-10-06", 0, "");
    expect(result.body.processed).toHaveLength(1);
    expect(blockedLogs()).toHaveLength(0);
  });
});

describe("HR sees the windows read-only; only the Super Admin sets them", () => {
  const HR = { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Hana HR" };
  const get = async (route, path, who) => {
    const token = createSessionToken({ ...who, email: `${who.user_id}@sacs.test`, session_id: "s-hr" });
    const response = await route.GET(new Request(`https://sacs.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    return { status: response.status, body: await response.json() };
  };
  it("HR reads the previous, current and next windows", async () => {
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    const hrRoute = await import("@/app/api/hr/payroll-runs/route");
    const result = await get(hrRoute, "/api/hr/payroll-runs?view=processing_windows", HR);
    expect(result.status).toBe(200);
    expect(result.body.windows.map((w) => w.period_label)).toEqual(["October 16-31, 2026", "November 1-15, 2026", "November 16-30, 2026"]);
    expect(result.body.set_by).toMatch(/Super Admin/);
  });
  it("HR cannot change the payslip schedule (System Configuration is the Super Admin's)", async () => {
    const scheduleRoute = await import("@/app/api/admin/payslip-schedule/route");
    const token = createSessionToken({ ...HR, email: "u-hr@sacs.test", session_id: "s-hr" });
    const response = await scheduleRoute.POST(new Request("https://sacs.test/api/admin/payslip-schedule", {
      method: "POST", headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ effective_from: "2026-12-01", window_days: 30, reason: "HR trying to widen the window" }),
    }));
    expect(response.status).toBe(403);
  });
});
