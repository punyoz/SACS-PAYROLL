/**
 * The accountant payroll route with attendance-driven deductions, run for
 * real against an in-memory Supabase stand-in.
 *
 * What has to hold:
 *   - attendance figures come from the logs on the server, never the browser;
 *   - rates are the versions in force on the period's first day;
 *   - an employee with an Incomplete / Pending Correction day is not
 *     processed, and the rest of the batch still is;
 *   - a manual change needs a reason and is recorded as a deviation;
 *   - every processed payslip carries its snapshot and traceable lines.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users, rpc } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const BRANCH = "branch-a";
const EMP_OK = "u-ok";
const EMP_BLOCKED = "u-blocked";
const PERIOD = "September 16-30, 2026";

function user(id, name, salary) {
  return {
    id,
    email: `${id}@sacs.test`,
    user_metadata: { role: "employee", full_name: name, employee_id: id.toUpperCase(), basic_salary: salary, branch_id: BRANCH },
  };
}

const log = (id, employeeId, date, fields = {}) => ({
  id,
  employee_id: employeeId,
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

const rate = (rateType, value, effectiveDate = "2026-01-01", extra = {}) => ({
  id: `cfg-${rateType}-${effectiveDate}`,
  rate_type: rateType,
  scope: "global",
  scope_ref: null,
  value,
  effective_date: effectiveDate,
  created_at: `${effectiveDate}T00:00:00Z`,
  ...extra,
});

let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;

function request(method, body, query = "") {
  const token = createSessionToken({
    user_id: "u-acct", role: "accountant", branch_id: BRANCH, email: "acct@sacs.test",
    full_name: "Ana Accountant", session_id: "s-1",
  });
  return new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-payroll-attendance";
  resetDb();
  users.push(user(EMP_OK, "Okay Employee", 20000), user(EMP_BLOCKED, "Blocked Employee", 20000));

  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH },
    { id: EMP_OK, full_name: "Okay Employee", email: "u-ok@sacs.test", branch_id: BRANCH },
    { id: EMP_BLOCKED, full_name: "Blocked Employee", email: "u-blocked@sacs.test", branch_id: BRANCH },
  );
  table("payroll_rate_configs").push(
    rate("hourly", 60),
    rate("hourly", 120, "2026-09-20"), // mid-period: must NOT apply to Sep 16-30
    rate("daily", 500),
    rate("half_day_pct", 50),
    rate("absent_pct", 100),
    rate("late_days_per_absent", 3),
    rate("late_minute_charge_pct", 0),
    rate("early_bird_bonus", 20),
    rate("perfect_attendance_bonus", 0),
    rate("sss_pct", 2),
    rate("philhealth_pct", 2),
    rate("pagibig_pct", 2),
  );
  table("attendance_logs").push(
    log("l1", EMP_OK, "2026-09-16", { status: "Late", late_minutes: 30 }),
    log("l6", EMP_OK, "2026-09-23", { status: "Late", late_minutes: 20 }),
    log("l7", EMP_OK, "2026-09-24", { status: "Late", late_minutes: 20 }),
    log("l2", EMP_OK, "2026-09-17", { status: "Undertime", undertime_minutes: 90 }),
    log("l3", EMP_OK, "2026-09-18", { status: "Half Day", is_half_day: true }),
    log("l4", EMP_OK, "2026-09-21", { status: "Absent", time_in: null, time_out: null }),
    log("l5", EMP_OK, "2026-09-22", { status: "Early Bird", is_early_bird: true }),
    log("b1", EMP_BLOCKED, "2026-09-16", { status: "Incomplete", time_out: null }),
    log("b2", EMP_BLOCKED, "2026-09-17"),
  );

  ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

// Expected for EMP_OK, Sep 16-30, basic 10,000 (half of 20,000):
//   3 late days = 1 absence = 500 (the minutes are not charged);
//   undertime 90 min × ₱60/h = 90; half day 50% × 500 = 250;
//   absent 100% × 500 = 500; early bird 1 × 20 = 20; contributions 2% = 200 each.
const EXPECTED = {
  late: 500, undertime: 90, half_day: 250, absent: 500, early_bird: 20,
  deductions: 200 * 3 + 500 + 90 + 250 + 500,
};

describe("GET: the batch table's figures", () => {
  it("computes attendance deductions from the logs with the rates in force on the period's first day", async () => {
    const response = await GET(request("GET", null, `?period=${encodeURIComponent(PERIOD)}`));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.payroll_ready).toBe(true);
    expect(rpc.calls).toContainEqual({ fn: "attendance_close_days", args: { p_from: "2026-09-16", p_to: "2026-09-30" } });

    const ok = body.attendance_rows.find((r) => r.employee_id === EMP_OK);
    expect(ok.rates.hourly).toBe(60);
    expect(ok.pay.amounts).toMatchObject({ late: 500, undertime: 90, half_day: 250, absent: 500, early_bird: 20 });
    expect(ok.late_days).toBe(3);
    expect(ok.defaults).toMatchObject({ basic_salary: 10000, sss: 200, philhealth: 200, pagibig: 200 });
    expect(ok.pay.blocking).toEqual([]);

    const blocked = body.attendance_rows.find((r) => r.employee_id === EMP_BLOCKED);
    expect(blocked.pay.blocking).toEqual([{ log_id: "b1", log_date: "2026-09-16", status: "Incomplete" }]);
    expect(blocked.unresolved_days).toBe(1);
  });
});

describe("POST batch_submit", () => {
  it("processes the unaffected employee, skips the one with unresolved attendance, and ignores attendance sent by the browser", async () => {
    const response = await POST(request("POST", {
      action: "batch_submit",
      pay_period: PERIOD,
      entries: [EMP_OK, EMP_BLOCKED].map((id) => ({
        employee_id: id,
        basic_salary: 10000,
        // Tampered attendance: must be ignored.
        deductions: { sss: 200, philhealth: 200, pagibig: 200, withholding_tax: 0, absences_days: 0, late_minutes: 0 },
      })),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed.map((p) => p.employee_id)).toEqual([EMP_OK]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatchObject({ employee_id: EMP_BLOCKED, code: "unresolved_attendance" });

    const record = table("payroll_records").find((r) => r.employee_id === EMP_OK);
    expect(record.total_deductions).toBe(EXPECTED.deductions);
    expect(record.total_incentives).toBe(EXPECTED.early_bird);
    expect(record.net_pay).toBe(10000 - EXPECTED.deductions + EXPECTED.early_bird);
    expect(record.base_pay).toBe(10000);
    expect(record.processed_by).toBe("u-acct");
    expect(record.processed_by_name).toBe("Ana Accountant");
    expect(record.rate_version_snapshot.hourly).toMatchObject({ value: 60, effective_date: "2026-01-01", config_id: "cfg-hourly-2026-01-01" });
    expect(record.attendance_snapshot.source_log_ids.sort()).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
    expect(record.period_start).toBe("2026-09-16");

    // Every attendance line traces to its log.
    const deductions = table("payroll_deductions").filter((d) => d.employee_id === EMP_OK);
    const byType = Object.fromEntries(deductions.map((d) => [d.type, d]));
    expect(byType.late).toMatchObject({ amount: 500, source_log_id: "l7", source_log_ids: ["l1", "l6", "l7"], payroll_record_id: record.id });
    expect(byType.undertime).toMatchObject({ amount: 90, source_log_id: "l2" });
    expect(byType.half_day).toMatchObject({ amount: 250, source_log_id: "l3" });
    expect(byType.absent).toMatchObject({ amount: 500, source_log_id: "l4" });
    expect(byType.sss).toMatchObject({ amount: 200, is_override: false });
    const incentives = table("payroll_incentives").filter((d) => d.employee_id === EMP_OK);
    expect(incentives).toEqual([expect.objectContaining({ type: "early_bird", amount: 20, source_log_id: "l5" })]);
  });

  it("refuses a changed contribution without a reason, and records it as a deviation with one", async () => {
    const entry = { employee_id: EMP_OK, basic_salary: 10000, deductions: { sss: 250, philhealth: 200, pagibig: 200 } };
    const noReason = await (await POST(request("POST", { action: "batch_submit", pay_period: PERIOD, entries: [entry] }))).json();
    expect(noReason.processed).toHaveLength(0);
    expect(noReason.skipped[0].code).toBe("override_reason_required");

    const withReason = await (await POST(request("POST", {
      action: "batch_submit", pay_period: PERIOD, entries: [entry], override_reason: "New SSS bracket",
    }))).json();
    expect(withReason.processed).toHaveLength(1);
    const record = table("payroll_records").find((r) => r.employee_id === EMP_OK);
    expect(record.deviations).toMatchObject({
      reason: "New SSS bracket",
      by: "u-acct",
      items: [{ field: "sss", default: 200, value: 250 }],
    });
    expect(table("payroll_deductions").find((d) => d.type === "sss")).toMatchObject({ amount: 250, is_override: true, note: "New SSS bracket" });
  });
});

describe("POST submit (Single Entry)", () => {
  it("refuses an employee with unresolved attendance with 422, not the 409 'already processed'", async () => {
    const response = await POST(request("POST", { action: "submit", employee_id: EMP_BLOCKED, pay_period: PERIOD, basic_salary: 10000 }));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("unresolved_attendance");
    expect(table("payroll_records")).toHaveLength(0);
  });

  it("allows an attendance override only with a reason, and keeps the computed lines plus an adjustment", async () => {
    const body = {
      action: "submit",
      employee_id: EMP_OK,
      pay_period: PERIOD,
      basic_salary: 10000,
      deductions: { sss: 200, philhealth: 200, pagibig: 200, withholding_tax: 0, absences_days: 0, late_days: 3, undertime_minutes: 90, half_days: 1 },
      incentives: { early_bird_days: 1, perfect_attendance: false },
    };
    const refused = await POST(request("POST", body));
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe("override_reason_required");

    const accepted = await POST(request("POST", { ...body, override_reason: "Absence was an approved field trip" }));
    expect(accepted.status).toBe(200);
    const record = table("payroll_records").find((r) => r.employee_id === EMP_OK);
    expect(record.total_deductions).toBe(EXPECTED.deductions - 500);
    expect(record.deviations.items).toEqual([{ field: "absences_days", default: 1, value: 0 }]);

    const absentLines = table("payroll_deductions").filter((d) => d.type === "absent");
    expect(absentLines).toEqual([
      expect.objectContaining({ amount: 500, source_log_id: "l4", is_override: false }),
      expect.objectContaining({ amount: -500, source_log_id: null, is_override: true, note: "Absence was an approved field trip" }),
    ]);
  });

  it("saves a draft without a reason, but still computes from the logs", async () => {
    const response = await POST(request("POST", { action: "save_draft", employee_id: EMP_BLOCKED, pay_period: PERIOD, basic_salary: 10000 }));
    expect(response.status).toBe(200);
    const entry = table("payroll_entries").find((e) => e.employee_id === EMP_BLOCKED);
    expect(entry.status).toBe("draft");
    expect(entry.payroll.audit.attendance.blocking).toHaveLength(1);
  });
});

describe("Daily rate per branch", () => {
  it("prices a branch's absences and lates from that branch's own daily rate", async () => {
    table("payroll_rate_configs").push(rate("daily", 800, "2026-09-01", { id: "cfg-branch-daily", scope: "branch", scope_ref: BRANCH }));
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(PERIOD)}`))).json();
    const ok = body.attendance_rows.find((r) => r.employee_id === EMP_OK);
    expect(ok.rates.daily).toBe(800);
    // No hourly rate of its own: 800 ÷ 8.
    expect(ok.rates.hourly).toBe(100);
    expect(ok.pay.amounts).toMatchObject({ absent: 800, late: 800, half_day: 400, undertime: 150 });
    expect(ok.rate_versions.daily).toMatchObject({ scope: "branch", effective_date: "2026-09-01" });
  });

  it("lets the rates screen list each branch's daily rate", async () => {
    table("branches").push({ id: BRANCH, name: "Pasig Branch", status: "Active" }, { id: "branch-b", name: "Cainta Branch", status: "Active" });
    table("payroll_rate_configs").push(rate("daily", 800, "2026-09-01", { id: "cfg-branch-daily", scope: "branch", scope_ref: BRANCH }));
    const { GET: ratesGET } = await import("@/app/api/admin/payroll-rates/route");
    const token = createSessionToken({ user_id: "u-sa", role: "super_admin", branch_id: null, email: "sa@sacs.test", full_name: "Sam", session_id: "s-2" });
    const response = await ratesGET(new Request("https://sacs.test/api/admin/payroll-rates", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    const body = await response.json();
    const byName = Object.fromEntries(body.branch_daily.map((b) => [b.name, b]));
    expect(byName["Pasig Branch"].current).toMatchObject({ value: 800, scope: "branch" });
    expect(byName["Cainta Branch"].current).toMatchObject({ value: 500, scope: "global" });
  });
});
