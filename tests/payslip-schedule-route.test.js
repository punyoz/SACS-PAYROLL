/**
 * The payslip schedule through the payroll API, once 20261009010000 is
 * applied (payroll_schedule_settings exists): generation opens ON the
 * period's generation day (the 15th / the month's last working day) and
 * stays open 5 days; the 2nd half reads attendance up to the day before;
 * an employee on payroll hold (AWOL / Separated) is never generated.
 *
 * Period used: October 1-15, 2026 → generated Thu Oct 15, open until Oct 19.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, setMissingTables, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-a";
const EMP = "u-emp";
const HELD = "u-held";
const OCT_1 = "October 1-15, 2026";
const OCT_16 = "October 16-31, 2026";

const rate = (rateType, value, effective = "2026-01-01") => ({
  id: `cfg-${rateType}-${effective}`, rate_type: rateType, scope: "global", scope_ref: null, value,
  effective_date: effective, created_at: `${effective}T00:00:00Z`,
});

let PATCH;
let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;

const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };

function request(method, body, query = "") {
  const token = createSessionToken({ ...ACCOUNTANT, email: "acct@sacs.test", session_id: "s-1" });
  return new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    method,
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function generate(on, employeeId = EMP, period = OCT_1) {
  vi.setSystemTime(new Date(`${on}T10:00:00+08:00`));
  const response = await PATCH(request("PATCH", { action: "generate", employee_id: employeeId, pay_period: period }));
  return { response, body: await response.json() };
}

const employee = (id, name, code) => ({
  id, email: `${id}@sacs.test`,
  user_metadata: { role: "employee", full_name: name, employee_id: code, basic_salary: 30000, branch_id: BRANCH, position: "Teacher I" },
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-payslip-schedule";
  resetDb();
  setMissingTables([]);   // the migration is applied: schedule settings exist (none saved = defaults)
  users.push(employee(EMP, "Maria Santos", "SACS-001"), employee(HELD, "Paolo Diaz", "SACS-002"));
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH },
    { id: EMP, full_name: "Maria Santos", email: `${EMP}@sacs.test`, branch_id: BRANCH, payroll_hold: false },
    { id: HELD, full_name: "Paolo Diaz", email: `${HELD}@sacs.test`, branch_id: BRANCH, payroll_hold: true, payroll_hold_reason: "AWOL: pay held until HR closes the case" },
  );
  table("branches").push({ id: BRANCH, name: "Antipolo" });
  table("attendance_holidays").push(
    { holiday_date: "2026-11-30", name: "Bonifacio Day", type: "holiday", day_part: "whole" },
    { holiday_date: "2026-12-30", name: "Rizal Day", type: "holiday", day_part: "whole" },
    { holiday_date: "2026-12-31", name: "Last Day of the Year", type: "special", day_part: "whole" },
  );
  table("payroll_rate_configs").push(
    rate("hourly", 60), rate("daily", 500), rate("half_day_pct", 50), rate("absent_pct", 100),
    rate("late_days_per_absent", 3), rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0),
    rate("perfect_attendance_bonus", 0), rate("sss_pct", 2), rate("philhealth_pct", 2), rate("pagibig_pct", 2),
    rate("attendance_lock_day", 15, "2026-10-01"), rate("carry_after_lock", 1, "2026-10-01"),
  );

  ({ GET, PATCH, POST } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  setMissingTables(["payroll_schedule_settings"]);
  vi.useRealTimers();
});

describe("Generation on the scheduled day", () => {
  it("Oct 9: not open yet; the banner shows the date and window", async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(OCT_1)}`))).json();
    expect(body.generation_window).toMatchObject({
      state: "not_open",
      scheduled: true,
      generation_date: "2026-10-15",
      closes_on: "2026-10-19",
      banner: "October 1-15, 2026: Payslip generation on Oct 15, 2026 · open until Oct 19, 2026",
    });
    const { response, body: refused } = await generate("2026-10-09");
    expect(response.status).toBe(403);
    expect(refused.code).toBe("generation_window");
    expect(refused.error).toContain("Oct 15, 2026");
  });

  it("Oct 14, the day before, is not open", async () => {
    const { response } = await generate("2026-10-14");
    expect(response.status).toBe(403);
  });

  it("Oct 15: the Final payslip, full Rate, nothing deducted", async () => {
    const { response, body } = await generate("2026-10-15");
    expect(response.status).toBe(200);
    const saved = table("payroll_entries").find((row) => row.employee_id === EMP && row.pay_period === OCT_1);
    expect(saved.status).toBe("paid");
    expect(body).toBeTruthy();
  });

  it("Oct 20: closed (a Super Admin override is needed)", async () => {
    const { response, body } = await generate("2026-10-20");
    expect(response.status).toBe(403);
    expect(body.error).toContain("closed on Oct 19, 2026");
  });

  it("the 2nd half generates Fri Oct 30 (Oct 31 is a Saturday) and reads attendance to Oct 29", async () => {
    vi.setSystemTime(new Date("2026-10-30T10:00:00+08:00"));
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(OCT_16)}`))).json();
    expect(body.generation_window).toMatchObject({ state: "final", generation_date: "2026-10-30", attendance_through: "2026-10-29" });
    expect(body.semi_monthly?.window).toEqual({ start_key: "2026-10-01", end_key: "2026-10-29" });
  });
});

const NOV_16 = "November 16-30, 2026";
const absentLog = (id, date) => ({
  id, employee_id: EMP, log_date: date, time_in: null, time_out: null, created_at: `${date}T00:00:00Z`,
  status: "Absent", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, branch_id: BRANCH,
  archived_duplicate: false,
});

describe("The generation day is the end of the payroll; its attendance goes to next month", () => {
  const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
  beforeEach(() => {
    // The 2nd half settles the month with the monthly tax table.
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
      id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
    })));
  });

  it("an absence ON the generation day (Fri Oct 30) is not deducted in October, but on the November payslip", async () => {
    table("attendance_logs").push(absentLog("a-29", "2026-10-29"), absentLog("a-30", "2026-10-30"));

    const oct = await generate("2026-10-30", EMP, OCT_16);
    expect(oct.response.status).toBe(200);
    const octEntry = table("payroll_entries").find((row) => row.employee_id === EMP && row.pay_period === OCT_16);
    expect(octEntry.payroll.monthly).toMatchObject({ absent_days: 1 });
    expect(octEntry.payroll.generation.attendance_summary).toMatchObject({ days_absent: 1, attendance_through: "2026-10-29" });

    // Nov 30 is Bonifacio Day: November generates Fri Nov 27, reading Oct 30 – Nov 26.
    const nov = await generate("2026-11-27", EMP, NOV_16);
    expect(nov.response.status).toBe(200);
    const novEntry = table("payroll_entries").find((row) => row.employee_id === EMP && row.pay_period === NOV_16);
    expect(novEntry.payroll.monthly).toMatchObject({ absent_days: 1, window: { start_key: "2026-10-30", end_key: "2026-11-26" } });
  });

  it("a day the Super Admin sets moves the generation day and the cut-off with it", async () => {
    // 2nd half on the 25th from Oct 16-31: Sun Oct 25 -> Fri Oct 23, attendance to Oct 22.
    table("payroll_schedule_settings").push({
      id: "sched-1", effective_from: "2026-10-16", first_half_day: null, second_half_day: 25, window_days: 5,
      non_working_day_rule: "previous_working_day", note: "School asked for the 25th", created_at: "2026-10-10T00:00:00Z",
    });
    table("attendance_logs").push(absentLog("a-22", "2026-10-22"), absentLog("a-23", "2026-10-23"));

    vi.setSystemTime(new Date("2026-10-22T10:00:00+08:00"));
    const before = await (await GET(request("GET", null, `?period=${encodeURIComponent(OCT_16)}`))).json();
    expect(before.generation_window).toMatchObject({ state: "not_open", generation_date: "2026-10-23", attendance_through: "2026-10-22" });

    const { response } = await generate("2026-10-23", EMP, OCT_16);
    expect(response.status).toBe(200);
    const saved = table("payroll_entries").find((row) => row.employee_id === EMP && row.pay_period === OCT_16);
    expect(saved.payroll.monthly).toMatchObject({ absent_days: 1, window: { start_key: "2026-10-01", end_key: "2026-10-22" } });
  });
});

describe("Payroll hold (AWOL / Separated)", () => {
  it("a held employee is not generated, not even inside the window", async () => {
    const { response, body } = await generate("2026-10-15", HELD);
    expect(response.status).toBe(409);
    expect(body.code).toBe("payroll_hold");
    expect(body.error).toContain("Paolo Diaz");
    expect(table("payroll_entries").some((row) => row.employee_id === HELD)).toBe(false);
  });

  it("the batch skips the held employee and says why", async () => {
    vi.setSystemTime(new Date("2026-10-15T10:00:00+08:00"));
    const response = await POST(request("POST", {
      action: "batch_submit", pay_period: OCT_1,
      entries: [{ employee_id: EMP }, { employee_id: HELD }],
    }));
    const body = await response.json();
    const skipped = (body.skipped || []).find((row) => row.employee_id === HELD);
    expect(skipped?.code).toBe("payroll_hold");
    expect(table("payroll_entries").some((row) => row.employee_id === HELD)).toBe(false);
  });

  it("the employee list marks who is held", async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(OCT_1)}`))).json();
    expect(body.employees.find((e) => e.id === HELD)).toMatchObject({ payroll_hold: true });
    expect(body.employees.find((e) => e.id === EMP)).toMatchObject({ payroll_hold: false });
  });
});
