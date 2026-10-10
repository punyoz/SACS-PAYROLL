/**
 * Payslip generation (PATCH /api/accountant/payroll { action: "generate" }):
 *
 *   - only from the period's last day (the generation day) up to its pay date (Manila
 *     dates), enforced by the API;
 *   - before the period ends: a Draft counting attendance up to today, which
 *     can be regenerated; after: the Final payslip, locked;
 *   - absences, late, undertime, half days and leave come from the period's
 *     attendance records (the corrected values when a day was corrected);
 *   - unresolved Incomplete days are refused until confirmed;
 *   - Accountant / Super Admin only; Super Admin may override a Final with a
 *     reason.
 *
 * Period used: September 16-30, 2026 (flat contribution rules, daily rate
 * 500). Window opens Sep 27; no Pay Calendar date, so the pay date is Oct 5.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const EMP = "u-emp";
const PERIOD = "September 16-30, 2026";

const log = (id, date, fields = {}) => ({
  id,
  employee_id: EMP,
  log_date: date,
  time_in: `${date}T00:00:00Z`,
  time_out: `${date}T09:00:00Z`,
  created_at: `${date}T00:00:00Z`,
  status: "On Time",
  late_minutes: 0,
  undertime_minutes: 0,
  is_half_day: false,
  is_early_bird: false,
  archived_duplicate: false,
  ...fields,
});
const absent = (id, date) => log(id, date, { status: "Absent", time_in: null, time_out: null });

const rate = (rateType, value) => ({
  id: `cfg-${rateType}`, rate_type: rateType, scope: "global", scope_ref: null, value,
  effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z",
});

let PATCH;
let GET;
let createSessionToken;
let SESSION_COOKIE;

const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };
const SUPER = { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" };

function request(who, method, body, query = "") {
  const token = createSessionToken({ ...who, email: `${who.user_id}@sacs.test`, session_id: "s-1" });
  return new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function generate(on, extra = {}, who = ACCOUNTANT) {
  vi.setSystemTime(new Date(`${on}T10:00:00+08:00`));
  const response = await PATCH(request(who, "PATCH", { action: "generate", employee_id: EMP, pay_period: PERIOD, ...extra }));
  return { response, body: await response.json() };
}

const entry = () => table("payroll_entries").find((row) => row.employee_id === EMP && row.pay_period === PERIOD);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-payslip-generation";
  resetDb();
  users.push({
    id: EMP, email: "emp@sacs.test",
    user_metadata: { role: "employee", full_name: "Emma Employee", employee_id: "SACS-001", basic_salary: 20000, branch_id: BRANCH, position: "Teacher I" },
  });
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH },
    { id: EMP, full_name: "Emma Employee", email: "emp@sacs.test", branch_id: BRANCH },
  );
  table("branches").push({ id: BRANCH, name: "Main Branch" });
  table("payroll_rate_configs").push(
    rate("hourly", 60), rate("daily", 500), rate("half_day_pct", 50), rate("absent_pct", 100),
    rate("late_days_per_absent", 3), rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0),
    rate("perfect_attendance_bonus", 0), rate("sss_pct", 2), rate("philhealth_pct", 2), rate("pagibig_pct", 2),
  );
  table("attendance_logs").push(log("ok-1", "2026-09-16"));

  ({ GET, PATCH } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Generation window", () => {
  it("rejects a request before the window opens, and says when it opens", async () => {
    const { response, body } = await generate("2026-09-29");
    expect(response.status).toBe(403);
    expect(body).toMatchObject({ code: "generation_window", error: "Payslip generation opens on Sep 30, 2026." });
    expect(entry()).toBeUndefined();

    vi.setSystemTime(new Date("2026-09-29T10:00:00+08:00"));
    const page = await (await GET(request(ACCOUNTANT, "GET", null, `?period=${encodeURIComponent(PERIOD)}`))).json();
    expect(page.generation_window).toMatchObject({ state: "not_open", opens_on: "2026-09-30", pay_date: "2026-10-05" });
  });

  it("on the generation day (the period's last day): a Draft counting attendance up to today only", async () => {
    // A day that has not happened yet must not count, even if a row exists.
    table("attendance_logs").push(absent("future", "2026-10-01"));
    const { response, body } = await generate("2026-09-30");
    expect(response.status).toBe(200);
    expect(body.status).toBe("draft");
    expect(entry()).toMatchObject({ status: "draft" });
    expect(entry().payroll.generation).toMatchObject({
      status: "draft", attendance_through: "2026-09-30", attendance_through_label: "Sep 30, 2026", generated_by_name: "Ana Accountant",
    });
    expect(entry().payroll.generation.attendance_summary.days_absent).toBe(0);
    expect(body.payslip).toMatchObject({ status: "draft", employee: { branch: "Main Branch", position: "Teacher I" } });
  });

  it("closes after the pay date (Super Admin override only)", async () => {
    const { response, body } = await generate("2026-10-06");
    expect(response.status).toBe(403);
    expect(body.error).toMatch(/closed on the pay date, Oct 5, 2026/);
  });

  it("refuses Process Payroll before the period ends", async () => {
    vi.setSystemTime(new Date("2026-09-28T10:00:00+08:00"));
    const { POST } = await import("@/app/api/accountant/payroll/route");
    const response = await POST(request(ACCOUNTANT, "POST", { action: "submit", employee_id: EMP, pay_period: PERIOD }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("generation_window");
  });
});

describe("Computed from attendance", () => {
  it("2 absences and 3 late days: Final payslip with each deduction's basis", async () => {
    table("attendance_logs").push(
      absent("a1", "2026-09-21"), absent("a2", "2026-09-22"),
      log("l1", "2026-09-17", { status: "Late", late_minutes: 10 }),
      log("l2", "2026-09-18", { status: "Late", late_minutes: 15 }),
      log("l3", "2026-09-23", { status: "Late", late_minutes: 20 }),
    );
    const { response, body } = await generate("2026-10-01");
    expect(response.status).toBe(200);
    expect(body.status).toBe("final");
    expect(entry()).toMatchObject({ status: "paid" });
    expect(entry().payslip_no).toMatch(/^PS-/);

    const { totals } = entry().payroll;
    expect(totals.absence_deduction).toBe(1000);
    // 3 late days = 1 absence (Payroll Rates rule).
    expect(totals.late_deduction).toBe(500);
    const summary = entry().payroll.generation.attendance_summary;
    expect(summary).toMatchObject({ days_absent: 2, late_days: 3, late_minutes: 45, attendance_through: "2026-09-30" });
    const basis = entry().payroll.generation.deduction_basis.map((line) => line.basis);
    expect(basis).toContain("Absent: 2 days × 500.00 = 1,000.00");
    expect(basis).toContain("Late: 3 late days ÷ 3 = 1 absence × 500.00 = 500.00");
    // Snapshot kept on the payroll record too.
    const record = table("payroll_records").find((row) => row.employee_id === EMP);
    expect(record.attendance_snapshot.generation.attendance_summary.days_absent).toBe(2);
  });

  it("uses a corrected record's values, not the original taps", async () => {
    // Originally Late by 100 minutes; HR corrected it to 08:00 (late 0).
    table("attendance_logs").push(log("c1", "2026-09-21", { status: "Corrected", late_minutes: 0 }));
    const { body } = await generate("2026-10-01");
    expect(body.status).toBe("final");
    const summary = entry().payroll.generation.attendance_summary;
    expect(summary).toMatchObject({ days_present: 2, days_absent: 0, late_minutes: 0 });
    expect(entry().payroll.totals.late_deduction).toBe(0);
  });

  it("does not count an Incomplete record silently: refused until confirmed", async () => {
    table("attendance_logs").push(log("i1", "2026-09-22", { status: "Incomplete", time_out: null }));
    const first = await generate("2026-09-30");
    expect(first.response.status).toBe(422);
    expect(first.body).toMatchObject({ code: "unresolved_attendance" });
    expect(first.body.error).toMatch(/Sep 22, 2026 \(Incomplete\)/);
    expect(entry()).toBeUndefined();

    const confirmed = await generate("2026-09-30", { confirm_incomplete: true });
    expect(confirmed.response.status).toBe(200);
    expect(entry().payroll.generation.confirmed_incomplete).toEqual([expect.objectContaining({ log_id: "i1", status: "Incomplete" })]);
    expect(entry().payroll.generation.attendance_summary).toMatchObject({ incomplete_days: 1, days_absent: 0 });
  });

  it("an approved leave with pay costs nothing", async () => {
    table("leave_requests").push({
      id: "lv1", employee_id: EMP, employee_name: "Emma Employee", position: "Employee", leave_type: "Vacation Leave",
      pay_status: "with_pay", start_date: "2026-09-21", end_date: "2026-09-22", reason: "r", proof_url: "", status: "approved",
      submitted_at: "2026-09-01T00:00:00Z",
    });
    table("attendance_logs").push(
      log("lv-a", "2026-09-21", { status: "On Leave", time_in: null, time_out: null, leave_request_id: "lv1" }),
      log("lv-b", "2026-09-22", { status: "On Leave", time_in: null, time_out: null, leave_request_id: "lv1" }),
    );
    await generate("2026-10-01");
    const { payroll } = entry();
    expect(payroll.totals.absence_deduction).toBe(0);
    expect(payroll.totals.leave_without_pay_deduction).toBe(0);
    expect(payroll.generation.attendance_summary).toMatchObject({ leave_with_pay_days: 2, leave_days: 2, days_absent: 0 });
  });

  it("an approved leave without pay is deducted like an absence", async () => {
    table("leave_requests").push({
      id: "lv2", employee_id: EMP, employee_name: "Emma Employee", position: "Employee", leave_type: "Personal Leave",
      pay_status: "without_pay", start_date: "2026-09-21", end_date: "2026-09-21", reason: "r", proof_url: "", status: "approved",
      submitted_at: "2026-09-01T00:00:00Z",
    });
    table("attendance_logs").push(log("lw-a", "2026-09-21", { status: "On Leave", time_in: null, time_out: null, leave_request_id: "lv2" }));
    await generate("2026-10-01");
    expect(entry().payroll.totals.leave_without_pay_deduction).toBe(500);
    expect(entry().payroll.generation.deduction_basis.map((line) => line.basis)).toContain("Leave without pay: 1 day × 500.00 = 500.00");
  });
});

describe("Draft, regenerate, Final", () => {
  it("regenerating a Draft after a new correction recomputes from the latest records", async () => {
    table("attendance_logs").push(absent("a1", "2026-09-24"));
    await generate("2026-09-30");
    expect(entry().payroll.totals.absence_deduction).toBe(500);

    // HR corrects the absence: worked 08:00-17:00.
    Object.assign(table("attendance_logs").find((row) => row.id === "a1"), {
      status: "Corrected", time_in: "2026-09-24T00:00:00Z", time_out: "2026-09-24T09:00:00Z",
    });
    const again = await generate("2026-09-30");
    expect(again.body.status).toBe("draft");
    expect(entry().payroll.totals.absence_deduction).toBe(0);
    expect(entry().payroll.generation).toMatchObject({ regenerations: 1, attendance_through: "2026-09-30" });
    expect(table("payroll_entries").filter((row) => row.employee_id === EMP)).toHaveLength(1);
    expect(table("audit_logs").some((row) => row.action === "payslip_regenerate")).toBe(true);
  });

  it("locks a Final payslip; only a Super Admin override with a reason changes it", async () => {
    await generate("2026-10-01");
    const firstNo = entry().payslip_no;

    const again = await generate("2026-10-02");
    expect(again.response.status).toBe(409);
    expect(again.body.code).toBe("payslip_locked");

    vi.setSystemTime(new Date("2026-10-08T10:00:00+08:00"));
    const noReason = await PATCH(request(SUPER, "PATCH", { action: "override_final", employee_id: EMP, pay_period: PERIOD, reason: "fix" }));
    expect(noReason.status).toBe(400);
    const notSuper = await PATCH(request(ACCOUNTANT, "PATCH", { action: "override_final", employee_id: EMP, pay_period: PERIOD, reason: "Late correction approved by HR" }));
    expect(notSuper.status).toBe(403);

    const override = await PATCH(request(SUPER, "PATCH", { action: "override_final", employee_id: EMP, pay_period: PERIOD, reason: "Late correction approved by HR" }));
    expect(override.status).toBe(200);
    const records = table("payroll_records").filter((row) => row.employee_id === EMP);
    expect(records.filter((row) => row.archived)).toHaveLength(1);
    expect(records.filter((row) => !row.archived)).toHaveLength(1);
    expect(entry().payroll.generation.override).toMatchObject({ reason: "Late correction approved by HR", by_name: "Sam Super", replaced_payslip_no: firstNo });
    expect(table("audit_logs").some((row) => row.action === "payslip_override")).toBe(true);
  });

  it("downloads the payslip as a PDF", async () => {
    await generate("2026-10-01");
    const response = await GET(request(ACCOUNTANT, "GET", null, `?format=pdf&entry_id=${entry().id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(bytes.toString("latin1")).toContain("Emma Employee");
  });
});

describe("Who may generate", () => {
  it("rejects non-Accountant / non-Super-Admin callers on the server", async () => {
    vi.setSystemTime(new Date("2026-10-01T10:00:00+08:00"));
    for (const who of [
      { user_id: "u-e", role: "employee", branch_id: BRANCH },
      { user_id: "u-a", role: "admin", branch_id: BRANCH },
      { user_id: "u-h", role: "hr", branch_id: null },
    ]) {
      const response = await PATCH(request(who, "PATCH", { action: "generate", employee_id: EMP, pay_period: PERIOD }));
      expect(response.status, who.role).toBe(403);
    }
    expect(entry()).toBeUndefined();
  });

  it("lets a Super Admin generate", async () => {
    const { response } = await generate("2026-10-01", {}, SUPER);
    expect(response.status).toBe(200);
  });
});
