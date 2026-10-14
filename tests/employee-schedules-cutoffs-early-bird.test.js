/**
 * Per-employee work schedules, per-cutoff semi-monthly payroll, the 7-day
 * leave rule and the Early Bird incentive
 * (supabase/migrations/20261013010000_employee_schedules_cutoffs_early_bird.sql).
 *
 * Late / Undertime / Absent themselves are decided by the database status
 * engine on each employee's own schedule; the attendance rows below carry
 * what it stores (late_minutes, undertime_minutes, arrival_offset_minutes).
 * The SQL side has its own scenarios: scripts/checks/employee-schedules-scenarios.sql.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { earliestLeaveStart, meetsAdvanceRule, LEAVE_ADVANCE_MESSAGE } from "@/lib/leave-requests/advance-rule";
import { earlyBirdStats, isEarlyTimeIn, parseEarlyBirdSettings, pickEarlyBirdWinner } from "@/lib/payroll/early-bird";
import { describeWorkingDays, isOffDay, scheduleRowToPolicy, validateScheduleInput } from "@/lib/attendance/work-schedules";
import { computeSecondHalf, firstHalfWindow, secondHalfWindow } from "@/lib/payroll/semi-monthly";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

afterEach(() => {
  vi.useRealTimers();
});

/* ── Part 3: leave must be filed 7 days ahead ──────────────────────────────── */

describe("Leave requests: at least 7 days before the start date", () => {
  it("filed Oct 13, 2026: the earliest start is Oct 20", () => {
    expect(earliestLeaveStart("2026-10-13")).toBe("2026-10-20");
    expect(earliestLeaveStart("2026-12-28")).toBe("2027-01-04");
  });

  it("uses the Manila date of the submission, not the server's", () => {
    // 11:30 PM Oct 12 UTC is 7:30 AM Oct 13 in Manila.
    const submitted = new Date("2026-10-12T23:30:00Z");
    expect(meetsAdvanceRule("2026-10-19", submitted)).toBe(false);
    expect(meetsAdvanceRule("2026-10-20", submitted)).toBe(true);
  });

  describe("POST /api/employee/leave-requests", () => {
    const EMP = "11111111-1111-4111-8111-111111111111";
    let POST;
    let createSessionToken;
    let SESSION_COOKIE;

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-13T09:00:00+08:00"));
      vi.resetModules();
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
      process.env.SESSION_SECRET = "test-secret-leave-advance";
      resetDb();
      table("profiles").push({ id: EMP, full_name: "Ella Employee", branch_id: "branch-a", role: "employee" });
      ({ POST } = await import("@/app/api/employee/leave-requests/route"));
      ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
    });

    const file = (startDate) => POST(new Request("https://sacs.test/api/employee/leave-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: EMP, role: "employee", branch_id: "branch-a", email: "ella@sacs.test", full_name: "Ella Employee", session_id: "s-1" })}`,
      },
      body: JSON.stringify({ leave_type: "Vacation Leave", pay_status: "with_pay", start_date: startDate, end_date: startDate, reason: "Family trip" }),
    }));

    it("rejects a start date 6 days away (Oct 19) with the rule's message", async () => {
      const response = await file("2026-10-19");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe(LEAVE_ADVANCE_MESSAGE);
      expect(body.error).toBe("Leave requests must be submitted at least 7 days before the leave start date.");
      expect(body.earliest_start).toBe("2026-10-20");
      expect(table("leave_requests")).toHaveLength(0);
    });

    it("accepts a start date 7 days away (Oct 20), pending, with the submission date and time", async () => {
      const response = await file("2026-10-20");
      expect(response.status).toBe(201);
      const [saved] = table("leave_requests");
      expect(saved).toMatchObject({ employee_id: EMP, start_date: "2026-10-20", status: "pending_admin" });
      expect(saved.submitted_at).toBe(new Date("2026-10-13T09:00:00+08:00").toISOString());
    });
  });
});

/* ── Part 1: schedule profiles ─────────────────────────────────────────────── */

describe("Work schedule profiles", () => {
  it("accepts a valid profile and normalises it", () => {
    const { value, error } = validateScheduleInput({
      name: "  Pre-school   Teacher ", work_start: "07:30", work_end: "12:30", grace_minutes: 10, work_hours: 5, working_days: [5, 1, 2, 3, 4, 4],
    });
    expect(error).toBeUndefined();
    expect(value).toEqual({ name: "Pre-school Teacher", work_start: "07:30", work_end: "12:30", grace_minutes: 10, work_hours: 5, working_days: [1, 2, 3, 4, 5] });
  });

  it.each([
    [{ name: "" }, /name/],
    [{ work_end: "07:00" }, /after work start/],
    [{ grace_minutes: -1 }, /grace/],
    [{ work_hours: 10 }, /longer than/],
    [{ working_days: [] }, /working day/],
  ])("refuses %o", (change, message) => {
    const base = { name: "Non-teaching Staff", work_start: "08:00", work_end: "17:00", grace_minutes: 15, work_hours: 8, working_days: [1, 2, 3, 4, 5, 6] };
    expect(validateScheduleInput({ ...base, ...change }).error).toMatch(message);
  });

  it("a Mon–Sat schedule works Saturdays; the default does not", () => {
    expect(isOffDay("2026-10-17", [1, 2, 3, 4, 5, 6])).toBe(false); // Saturday
    expect(isOffDay("2026-10-17", null)).toBe(true);
    expect(isOffDay("2026-10-18", [1, 2, 3, 4, 5, 6])).toBe(true);  // Sunday
    expect(describeWorkingDays([1, 2, 3, 4, 5, 6])).toBe("Mon–Sat");
  });

  it("shapes the database's schedule row like the branch policy", () => {
    expect(scheduleRowToPolicy({ work_start: 450, work_end: 750, grace: 10, work_hours: 5, working_days: [1, 2, 3, 4, 5], source: "level", schedule_name: "Pre-school Teacher" }))
      .toMatchObject({ work_start: "07:30", work_end: "12:30", grace: 10, work_hours: 5, source: "level", schedule_name: "Pre-school Teacher" });
    expect(scheduleRowToPolicy({})).toBeNull();
  });
});

describe("GET / POST /api/admin/work-schedules", () => {
  const BRANCH = "branch-a";
  const PRE = "aaaaaaaa-0000-4000-8000-000000000001";
  const SHS = "aaaaaaaa-0000-4000-8000-000000000002";
  let GET;
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;

  const as = (role, method = "GET", body = null) => new Request("https://sacs.test/api/admin/work-schedules", {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: `u-${role}`, role, branch_id: role === "super_admin" || role === "hr" ? null : BRANCH, email: `${role}@sacs.test`, full_name: role, session_id: `s-${role}` })}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T09:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-work-schedules";
    resetDb();
    table("branches").push({ id: BRANCH, name: "Main" });
    table("profiles").push(
      { id: "u-admin", branch_id: BRANCH, role: "admin" },
      // Same branch, three different schedules.
      { id: "cccccccc-0000-4000-8000-00000000000a", full_name: "Ana Preschool", employee_id: "SACS-001", branch_id: BRANCH, role: "employee", archived: false, employee_level: "preschool" },
      { id: "cccccccc-0000-4000-8000-00000000000b", full_name: "Ben Senior High", employee_id: "SACS-002", branch_id: BRANCH, role: "employee", archived: false, employee_level: "senior_high" },
      { id: "cccccccc-0000-4000-8000-00000000000c", full_name: "Cora Clerk", employee_id: "SACS-003", branch_id: BRANCH, role: "employee", archived: false, employee_level: "non_teaching" },
    );
    table("work_schedules").push(
      { id: "v1", schedule_key: PRE, name: "Pre-school Teacher", work_start: "07:30:00", work_end: "12:30:00", grace_minutes: 10, work_hours: 5, working_days: [1, 2, 3, 4, 5], effective_from: "2026-10-01", archived: false, created_at: "2026-10-01T00:00:00Z" },
      { id: "v2", schedule_key: SHS, name: "Senior High School Teacher", work_start: "08:00:00", work_end: "17:00:00", grace_minutes: 15, work_hours: 8, working_days: [1, 2, 3, 4, 5], effective_from: "2026-10-01", archived: false, created_at: "2026-10-01T00:00:00Z" },
    );
    table("work_schedule_assignments").push(
      // Pre-school level → Pre-school Teacher; Ben has his own schedule.
      { id: "a1", employee_level: "preschool", schedule_key: PRE, effective_from: "2026-10-01", created_at: "2026-10-01T00:00:00Z" },
      { id: "a2", employee_id: "cccccccc-0000-4000-8000-00000000000b", schedule_key: SHS, effective_from: "2026-10-01", created_at: "2026-10-01T00:00:00Z" },
      // A change that starts mid-period: Ana gets her own schedule from Oct 20.
      { id: "a3", employee_id: "cccccccc-0000-4000-8000-00000000000a", schedule_key: SHS, effective_from: "2026-10-20", created_at: "2026-10-12T00:00:00Z" },
    );
    table("system_config").push({ section: "attendance", key: "work_start", value: "08:30" });
    ({ GET, POST } = await import("@/app/api/admin/work-schedules/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("employees of one branch follow different schedules: own → level → branch / default", async () => {
    const body = await (await GET(as("super_admin"))).json();
    expect(body.available).toBe(true);
    expect(body.can_edit).toBe(true);
    const by = Object.fromEntries(body.employees.map((e) => [e.id, e]));
    expect(by["cccccccc-0000-4000-8000-00000000000a"].follows).toMatchObject({ source: "level", name: "Pre-school Teacher", work_start: "07:30", work_end: "12:30", grace: 10 });
    expect(by["cccccccc-0000-4000-8000-00000000000b"].follows).toMatchObject({ source: "employee", name: "Senior High School Teacher", work_start: "08:00", work_end: "17:00" });
    expect(by["cccccccc-0000-4000-8000-00000000000c"].follows).toMatchObject({ source: "default", work_start: "08:30" });
    // The change from Oct 20 is upcoming, not applied yet.
    expect(by["cccccccc-0000-4000-8000-00000000000a"].own_upcoming[0]).toMatchObject({ effective_from: "2026-10-20", schedule_name: "Senior High School Teacher" });
  });

  it("HR changes an employee's schedule (allowed, logged with the HR role)", async () => {
    const CORA = "cccccccc-0000-4000-8000-00000000000c";
    const hr = await (await GET(as("hr"))).json();
    expect(hr.can_edit).toBe(true);
    const response = await POST(as("hr", "POST", {
      action: "assign", target: "employee", employee_ids: [CORA], schedule_key: PRE, effective_from: "2026-10-14", note: "Moved to the pre-school wing",
    }));
    expect(response.status).toBe(200);
    expect(table("work_schedule_assignments").find((row) => row.employee_id === CORA))
      .toMatchObject({ schedule_key: PRE, effective_from: "2026-10-14", created_by_name: "hr" });
    const [entry] = table("audit_logs").filter((row) => row.module === "work_schedules");
    expect(entry).toMatchObject({ action: "schedule_assign_employee", actor_role: "hr", actor_name: "hr" });
    expect(entry.description).toBe("Cora Clerk follows Pre-school Teacher from 2026-10-14, by hr (HR).");
    expect(entry.metadata).toMatchObject({ changed_by_role: "hr", schedule_key: PRE, effective_from: "2026-10-14" });

    // HR has the same full power: create, edit (a new version) and delete.
    const profile = { name: "Grade School Teacher", work_start: "07:45", work_end: "16:00", grace_minutes: 10, work_hours: 7.5, working_days: [1, 2, 3, 4, 5] };
    expect((await POST(as("hr", "POST", { action: "save_schedule", ...profile, effective_from: "2026-10-13" }))).status).toBe(200);
    const grade = table("work_schedules").find((row) => row.name === "Grade School Teacher");
    expect((await POST(as("hr", "POST", { action: "save_schedule", schedule_key: grade.schedule_key, ...profile, work_start: "07:30", effective_from: "2026-11-01" }))).status).toBe(200);
    expect((await POST(as("hr", "POST", { action: "delete_schedule", schedule_key: grade.schedule_key, effective_from: "2026-12-01" }))).status).toBe(200);
    expect(table("work_schedules").filter((row) => row.schedule_key === grade.schedule_key).map((row) => [row.effective_from, row.work_start, row.archived]))
      .toEqual([["2026-10-13", "07:45", false], ["2026-11-01", "07:30", false], ["2026-12-01", "07:30", true]]);
    expect(table("audit_logs").filter((row) => row.module === "work_schedules").map((row) => row.action))
      .toEqual(["schedule_assign_employee", "schedule_create", "schedule_update", "schedule_delete"]);
  });

  it("a non-HR Admin (and the Accountant) can view but are blocked by the server", async () => {
    const CORA = "cccccccc-0000-4000-8000-00000000000c";
    const admin = await (await GET(as("admin"))).json();
    expect(admin.can_edit).toBe(false);
    expect(admin.employees).toHaveLength(3);
    for (const role of ["admin", "accountant"]) {
      const response = await POST(as(role, "POST", { action: "assign", target: "employee", employee_ids: [CORA], schedule_key: PRE, effective_from: "2026-10-14" }));
      expect(response.status).toBe(403);
    }
    expect((await POST(as("admin", "POST", { action: "delete_schedule", schedule_key: PRE, effective_from: "2026-10-14" }))).status).toBe(403);
    expect((await POST(as("admin", "POST", { action: "set_level", employee_ids: [CORA], level: "preschool" }))).status).toBe(403);
    expect(table("work_schedule_assignments")).toHaveLength(3);
    expect(table("work_schedules")).toHaveLength(2);
    // The proxy refuses the Admin's write before the handler runs, too.
    const { proxy } = await import("@/proxy");
    const direct = as("admin", "POST", { action: "assign" });
    direct.nextUrl = new URL(direct.url);
    expect((await proxy(direct)).status).toBe(403);
  });

  it("refuses an effective date before today, so past attendance is never recalculated", async () => {
    const response = await POST(as("super_admin", "POST", {
      action: "assign", target: "employee", employee_ids: ["cccccccc-0000-4000-8000-00000000000c"], schedule_key: PRE, effective_from: "2026-10-12",
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/before today/);
  });

  it("creates a profile, assigns by level and by employee, and logs every change", async () => {
    let response = await POST(as("super_admin", "POST", {
      action: "save_schedule", name: "Non-teaching Staff", work_start: "08:00", work_end: "17:00", grace_minutes: 5, work_hours: 8, working_days: [1, 2, 3, 4, 5, 6], effective_from: "2026-10-13",
    }));
    expect(response.status).toBe(200);
    const created = table("work_schedules").find((row) => row.name === "Non-teaching Staff");
    expect(created).toMatchObject({ grace_minutes: 5, working_days: [1, 2, 3, 4, 5, 6], effective_from: "2026-10-13", created_by_name: "super_admin" });

    response = await POST(as("super_admin", "POST", { action: "assign", target: "level", level: "non_teaching", schedule_key: created.schedule_key, effective_from: "2026-10-16" }));
    expect(response.status).toBe(200);
    response = await POST(as("super_admin", "POST", { action: "set_level", employee_ids: ["cccccccc-0000-4000-8000-00000000000b"], level: "high_school" }));
    expect(response.status).toBe(200);
    expect(table("profiles").find((row) => row.id === "cccccccc-0000-4000-8000-00000000000b").employee_level).toBe("high_school");

    const audit = table("audit_logs").filter((row) => row.module === "work_schedules").map((row) => row.action);
    expect(audit).toEqual(["schedule_create", "schedule_assign_level", "employee_level_update"]);
  });

  it("will not delete a schedule that is still assigned", async () => {
    const response = await POST(as("hr", "POST", { action: "delete_schedule", schedule_key: SHS, effective_from: "2026-10-20" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/before deleting/);
  });
});

/* ── Part 2: per-cutoff windows and the month's tax ────────────────────────── */

describe("Per-cutoff windows", () => {
  const lockOn29 = () => 29;
  it("each half reads its own days; a day still in progress carries forward", () => {
    // Oct 1-15 generated Oct 15 → Oct 1-14; Oct 16-31 generated Oct 30 → Oct 15-29.
    const first = firstHalfWindow("2026-10", lockOn29, "2026-10-14");
    expect(first).toEqual({ start_key: "2026-10-01", end_key: "2026-10-14" });
    expect(secondHalfWindow("2026-10", lockOn29, first)).toEqual({ start_key: "2026-10-15", end_key: "2026-10-29" });
    // November 1-15 starts where October's 2nd half stopped.
    expect(firstHalfWindow("2026-11", (m) => (m === "2026-10" ? 29 : 26), "2026-11-15")).toEqual({ start_key: "2026-10-30", end_key: "2026-11-15" });
  });

  it("the 2nd half taxes the whole month once and pays Rate − its own attendance − deductions", () => {
    const settle = computeSecondHalf({
      monthlySalary: 52200,
      absenceDeduction: 2400,           // 2nd cutoff's absence
      priorAttendance: 250,             // 1st cutoff's late + undertime
      contributions: { sss: 1750, philhealth: 1305, pagibig: 200 },
      taxTable: [{ over: 0, base: 0, rate: 0 }, { over: 20833, base: 0, rate: 0.15 }, { over: 33333, base: 1875, rate: 0.2 }],
      firstHalfPaid: 25850,
    });
    expect(settle.monthly_gross).toBe(49550);
    expect(settle.taxable_income).toBe(46295);
    expect(settle.withholding_tax).toBe(4467.4);
    expect(settle.second_half_net).toBe(15977.6);       // 26,100 − 2,400 − 3,255 − 4,467.40
    expect(settle.this_half_attendance_deductions).toBe(2400);
  });
});

/* ── Part 4: Early Bird ────────────────────────────────────────────────────── */

describe("Early Bird: what counts as early", () => {
  it("exactly 15 minutes before the employee's own start counts; 14 does not", () => {
    expect(isEarlyTimeIn(-15, 15)).toBe(true);   // 7:45 for an 8:00 start
    expect(isEarlyTimeIn(-14, 15)).toBe(false);  // 7:46
    expect(isEarlyTimeIn(-10, 15)).toBe(false);  // 7:50
    expect(isEarlyTimeIn(-10, 10)).toBe(true);   // the threshold is a setting
    expect(isEarlyTimeIn(null, 15)).toBe(false);
  });

  it("is measured against each employee's own start: 7:15 is early for 7:30, not for 8:00 when 15 min", () => {
    const stats = earlyBirdStats([
      // Pre-school (7:30 start) timing in at 7:15 → −15; Senior High (8:00) at 7:50 → −10.
      { id: "p1", employee_id: "pre", status: "On Time", log_date: "2026-10-01", time_in: "2026-09-30T23:15:00Z", arrival_offset_minutes: -15 },
      { id: "s1", employee_id: "shs", status: "On Time", log_date: "2026-10-01", time_in: "2026-09-30T23:50:00Z", arrival_offset_minutes: -10 },
      // Without a stored offset: time in vs the stored shift start (8:00 = 480).
      { id: "s2", employee_id: "shs", status: "On Time", log_date: "2026-10-02", time_in: "2026-10-01T23:45:00Z", shift_start_minutes: 480 },
    ], { threshold: 15 });
    expect(stats.get("pre")).toMatchObject({ early_count: 1, early_log_ids: ["p1"] });
    expect(stats.get("shs")).toMatchObject({ early_count: 1, early_log_ids: ["s2"], average_offset_minutes: -12.5 });
  });

  it("reads its settings with safe defaults", () => {
    expect(parseEarlyBirdSettings({})).toEqual({ threshold_minutes: 15, incentive_amount: 0, exclude_unexcused_absence: true });
    expect(parseEarlyBirdSettings({ threshold_minutes: "20", incentive_amount: "500", exclude_unexcused_absence: "false" }))
      .toEqual({ threshold_minutes: 20, incentive_amount: 500, exclude_unexcused_absence: false });
  });
});

describe("Early Bird: one winner, tie-breakers, eligibility", () => {
  const person = (id, fields) => ({ employee_id: id, employee_name: id, employee_code: id, early_count: 5, average_offset_minutes: -20, late_count: 0, absent_count: 0, ...fields });

  it("most early time-ins wins", () => {
    expect(pickEarlyBirdWinner([person("A", { early_count: 6 }), person("B", { early_count: 7 })]).winner.employee_id).toBe("B");
  });

  it("tie 1: the earliest average time-in against their own start", () => {
    const { winner } = pickEarlyBirdWinner([person("A", { average_offset_minutes: -18 }), person("B", { average_offset_minutes: -22.5 })]);
    expect(winner.employee_id).toBe("B");
    expect(winner.tie_broken_by).toBeUndefined();
  });

  it("tie 2: fewest late arrivals, then tie 3: fewest absences", () => {
    expect(pickEarlyBirdWinner([person("A", { late_count: 2 }), person("B", { late_count: 1 })]).winner.employee_id).toBe("B");
    expect(pickEarlyBirdWinner([person("A", { absent_count: 1 }), person("B", { absent_count: 2 })], { excludeUnexcused: false }).winner.employee_id).toBe("A");
  });

  it("a complete tie is settled by the lower employee ID and says so", () => {
    const { winner } = pickEarlyBirdWinner([person("SACS-010"), person("SACS-002")]);
    expect(winner.employee_id).toBe("SACS-002");
    expect(winner.tie_broken_by).toBe("employee_code");
  });

  it("an unexcused absence makes an employee ineligible (while the setting is on)", () => {
    const pool = [person("A", { early_count: 9, absent_count: 1 }), person("B", { early_count: 3 })];
    expect(pickEarlyBirdWinner(pool).winner.employee_id).toBe("B");
    expect(pickEarlyBirdWinner(pool, { excludeUnexcused: false }).winner.employee_id).toBe("A");
    expect(pickEarlyBirdWinner([person("A", { early_count: 0 })]).winner).toBeNull();
  });
});

/* ── Payroll through the route: 1st and 2nd cutoff, Early Bird line ────────── */

describe("Semi-monthly payroll per cutoff, with the Early Bird incentive", () => {
  const BRANCH = "branch-a";
  const ANA = "u-ana";   // Pre-school teacher, 7:30 start
  const BEN = "u-ben";   // Senior High teacher, 8:00 start
  const FIRST = "October 1-15, 2026";
  const SECOND = "October 16-31, 2026";
  const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
  const LEGAL = {
    sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000,
    philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000,
  };
  const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
    id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
  });
  // Rows as the status engine stores them for each employee's own schedule.
  const log = (id, employeeId, date, fields = {}) => ({
    id, employee_id: employeeId, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`, created_at: `${date}T00:00:00Z`,
    status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false,
    arrival_offset_minutes: 0, ...fields,
  });

  let GET;
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;
  const request = (method, body, query = "") => new Request(`https://sacs.test/api/accountant/payroll${query}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: "u-acct", role: "accountant", branch_id: BRANCH, email: "acct@sacs.test", full_name: "Ana Accountant", session_id: "s-1" })}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-cutoffs";
    resetDb();
    users.push(
      { id: ANA, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Preschool", employee_id: "SACS-001", basic_salary: 52200, branch_id: BRANCH } },
      { id: BEN, email: "ben@sacs.test", user_metadata: { role: "employee", full_name: "Ben Senior High", employee_id: "SACS-002", basic_salary: 52200, branch_id: BRANCH } },
    );
    table("profiles").push(
      { id: "u-acct", branch_id: BRANCH },
      { id: ANA, full_name: "Ana Preschool", email: "ana@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-001", archived: false, employee_level: "preschool" },
      { id: BEN, full_name: "Ben Senior High", email: "ben@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-002", archived: false, employee_level: "senior_high" },
    );
    // Salary 52,200: daily 2,400, hourly 300; late and undertime ₱5 a minute.
    table("payroll_rate_configs").push(
      rate("hourly", 68.75), rate("daily", 550), rate("half_day_pct", 50), rate("absent_pct", 100),
      // The retired per-day Early Bird bonus is still on file at ₱20: nothing
      // may pay it (Ana and Ben each have two Early Bird days).
      rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 100), rate("early_bird_bonus", 20), rate("perfect_attendance_bonus", 0),
      ...Object.entries({ ...LEGAL, overtime_premium_pct: 25, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30, working_days_per_year: 261 })
        .map(([type, value]) => rate(type, value, "2026-10-01")),
    );
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
      id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
    })));
    table("system_config").push(
      { section: "early_bird", key: "threshold_minutes", value: "15" },
      { section: "early_bird", key: "incentive_amount", value: "500" },
      { section: "early_bird", key: "exclude_unexcused_absence", value: "true" },
    );
    table("attendance_logs").push(
      // Ana (7:30): 7:10 and exactly 7:15 are early; late 20 min Oct 5; 30 min undertime Oct 6.
      log("a1", ANA, "2026-10-01", { arrival_offset_minutes: -20, status: "Early Bird", is_early_bird: true }),
      log("a2", ANA, "2026-10-02", { arrival_offset_minutes: -15, status: "Early Bird", is_early_bird: true }),
      log("a3", ANA, "2026-10-05", { arrival_offset_minutes: 20, status: "Late", late_minutes: 20 }),
      log("a4", ANA, "2026-10-06", { arrival_offset_minutes: 0, status: "Undertime", undertime_minutes: 30 }),
      // Ben (8:00): 7:45 and 7:44 are early; late 10 min Oct 7.
      log("b1", BEN, "2026-10-01", { arrival_offset_minutes: -15, status: "Early Bird", is_early_bird: true }),
      log("b2", BEN, "2026-10-02", { arrival_offset_minutes: -16, status: "Early Bird", is_early_bird: true }),
      log("b3", BEN, "2026-10-07", { arrival_offset_minutes: 10, status: "Late", late_minutes: 10 }),
      // 2nd cutoff: Ana absent Oct 19, 14 min early Oct 20 (does not count).
      log("a5", ANA, "2026-10-19", { time_in: null, time_out: null, status: "Absent", arrival_offset_minutes: null }),
      log("a6", ANA, "2026-10-20", { arrival_offset_minutes: -14 }),
    );
    ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  async function processFirst() {
    const response = await POST(request("POST", { action: "batch_submit", pay_period: FIRST, entries: [{ employee_id: ANA }, { employee_id: BEN }] }));
    expect(response.status).toBe(200);
    expect((await response.json()).processed).toHaveLength(2);
  }

  it("Early Bird tie on count (2 each): Ben wins on the earlier average time-in; shown on the payroll page", async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(FIRST)}`))).json();
    expect(body.semi_monthly).toMatchObject({ half: "first", per_cutoff: true, attendance_window: { start_key: "2026-10-01", end_key: "2026-10-15" } });
    expect(body.early_bird.winner).toMatchObject({ employee_id: BEN, employee_name: "Ben Senior High", early_count: 2, amount: 500, finalized: false });
    const stored = table("early_bird_winners").find((row) => row.period_label === FIRST);
    expect(stored).toMatchObject({ employee_id: BEN, early_count: 2, amount: 500, threshold_minutes: 15, source_log_ids: ["b1", "b2"] });
    expect(stored.ranking.map((r) => r.employee_id)).toEqual([BEN, ANA]);
  });

  it("1st cutoff payslip: attendance only — no tax, contributions or loans; the winner's incentive is its own line", async () => {
    await processFirst();
    const ana = table("payroll_entries").find((e) => e.employee_id === ANA && e.pay_period === FIRST);
    // 26,100 − late 20 min × 5 − undertime 30 min × 5.
    expect(ana.payroll.totals).toMatchObject({ gross_pay: 26100, late_deduction: 100, undertime_deduction: 150, total_deductions: 250, net_pay: 25850, early_bird_winner_incentive: 0 });
    expect(ana.payroll.deductions).toMatchObject({ sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, loan: 0 });
    expect(ana.payroll.monthly.cutoff.deductions.map((l) => l.label)).toEqual(["Late (1 day)", "Undertime (30 minutes)"]);
    expect(ana.payroll.early_bird).toBeUndefined();

    const ben = table("payroll_entries").find((e) => e.employee_id === BEN && e.pay_period === FIRST);
    expect(ben.payroll.totals).toMatchObject({ late_deduction: 50, early_bird_winner_incentive: 500, total_incentives: 500, net_pay: 26550 });
    expect(ben.payroll.monthly.cutoff.earnings).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Early Bird Incentive", amount: 500 })]));
    expect(ben.payroll.monthly.cutoff.gross_pay).toBe(26600); // the incentive is part of gross pay
    const line = table("payroll_incentives").find((l) => l.employee_id === BEN && l.type === "early_bird_incentive");
    expect(line).toMatchObject({ amount: 500, source_log_ids: ["b1", "b2"] });
    expect(table("payroll_incentives").filter((l) => l.employee_id === ANA && l.type === "early_bird_incentive")).toHaveLength(0);
  });

  it("2nd cutoff payslip: 16th–end attendance, every deduction on its own line, tax on the whole month", async () => {
    await processFirst();
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    const response = await POST(request("POST", {
      action: "batch_submit", pay_period: SECOND,
      entries: [{ employee_id: ANA }, { employee_id: BEN }],
    }));
    expect(response.status).toBe(200);

    const ana = table("payroll_entries").find((e) => e.employee_id === ANA && e.pay_period === SECOND);
    // Month: 52,200 − (250 + 2,400) = 49,550; contributions 3,255; taxable
    // 46,295 → 1,875 + 20% × 12,962 = 4,467.40. Net 26,100 − 2,400 − 3,255 − 4,467.40.
    expect(ana.payroll.monthly).toMatchObject({ attendance_rule: "per_cutoff", window: { start_key: "2026-10-16", end_key: "2026-10-31" }, taxable_income: 46295, withholding_tax: 4467.4 });
    expect(ana.payroll.totals).toMatchObject({ absence_deduction: 2400, late_deduction: 0, undertime_deduction: 0, net_pay: 15977.6 });
    expect(ana.payroll.monthly.cutoff.deductions.map((l) => [l.label, l.amount])).toEqual([
      ["Absences (1 day)", 2400], ["SSS", 1750], ["PhilHealth", 1305], ["Pag-IBIG", 200], ["Withholding tax", 4467.4],
    ]);
    expect(ana.payroll.monthly.cutoff).toMatchObject({ gross_pay: 26100, total_deductions: 10122.4, net_pay: 15977.6 });

    // Ben: the 1st cutoff's ₱500 incentive and ₱50 late are in the month taxed:
    // 52,200 − 50 + 500 = 52,650; taxable 49,395 → 5,087.40; net 26,100 − 3,255 − 5,087.40.
    const ben = table("payroll_entries").find((e) => e.employee_id === BEN && e.pay_period === SECOND);
    expect(ben.payroll.monthly).toMatchObject({ taxable_income: 49395, withholding_tax: 5087.4 });
    expect(ben.payroll.totals.net_pay).toBe(17757.6);

    // Nobody qualified in the 2nd cutoff: Ana was absent and 14 minutes early does not count.
    expect(table("early_bird_winners").find((row) => row.period_label === SECOND)).toMatchObject({ employee_id: null, amount: 0 });
    expect(table("payroll_incentives").filter((l) => l.type === "early_bird_incentive")).toHaveLength(1);
  });

  it("a new payslip has no per-day bonus; an old Final payslip still shows the one it paid", async () => {
    // September 16-30, 2026: Final before the bonus was retired (2 days × ₱20).
    table("payroll_entries").push({
      id: "entry-sep-2", employee_id: BEN, employee_name: "Ben Senior High", employee_code: "SACS-002", pay_period: "September 16-30, 2026",
      status: "paid", payslip_no: "PS-202609-0007", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
      payroll: {
        basic_salary: 26100, incentives: { early_bird_days: 2, perfect_attendance: false },
        totals: { gross_pay: 26100, total_deductions: 0, early_bird_incentive: 40, total_incentives: 40, net_pay: 26140 },
      },
    });
    await processFirst();

    const ben = table("payroll_entries").find((e) => e.employee_id === BEN && e.pay_period === FIRST);
    expect(ben.payroll.totals.early_bird_incentive).toBeUndefined();
    expect(ben.payroll.incentives.early_bird_days).toBeUndefined();
    expect(ben.payroll.totals.total_incentives).toBe(500); // the Early Bird Incentive only
    expect(ben.payroll.monthly.cutoff.earnings.map((l) => l.label)).not.toContain("Early bird bonus");
    expect(table("payroll_incentives").filter((l) => l.type === "early_bird")).toHaveLength(0);

    const fresh = (await (await GET(request("GET", null, `?entry_id=${ben.id}`))).json()).payslip;
    expect(fresh.incentives).toMatchObject({ early_bird_incentive: 0, early_bird_winner_incentive: 500 });

    const old = (await (await GET(request("GET", null, "?entry_id=entry-sep-2"))).json()).payslip;
    expect(old.incentives).toMatchObject({ early_bird_days: 2, early_bird_incentive: 40, early_bird_winner_incentive: 0 });
    expect(old.net_pay).toBe(26140);
    // Untouched in the database.
    expect(table("payroll_entries").find((e) => e.id === "entry-sep-2").payroll.totals).toMatchObject({ early_bird_incentive: 40, net_pay: 26140 });
  });
});

describe("Early Bird settings: Super Admin and HR change them, others cannot", () => {
  let GET;
  let PATCH;
  let createSessionToken;
  let SESSION_COOKIE;
  const as = (role, method = "GET", body = null) => new Request("https://sacs.test/api/admin/early-bird", {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: `u-${role}`, role, branch_id: role === "super_admin" || role === "hr" ? null : "branch-a", email: `${role}@sacs.test`, full_name: role, session_id: `s-${role}` })}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-early-bird-settings";
    resetDb();
    table("profiles").push({ id: "u-admin", branch_id: "branch-a", role: "admin" });
    table("system_config").push(
      { section: "early_bird", key: "threshold_minutes", value: "15" },
      { section: "early_bird", key: "incentive_amount", value: "0" },
      { section: "early_bird", key: "exclude_unexcused_absence", value: "true" },
    );
    ({ GET, PATCH } = await import("@/app/api/admin/early-bird/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("HR sets the threshold, the eligibility rule and the amount, logged with the HR role", async () => {
    expect((await (await GET(as("hr"))).json())).toMatchObject({ can_edit_settings: true, can_edit_amount: true });
    const response = await PATCH(as("hr", "PATCH", { threshold_minutes: 20, exclude_unexcused_absence: false, incentive_amount: 750 }));
    expect(response.status).toBe(200);
    expect((await response.json()).settings).toEqual({ threshold_minutes: 20, incentive_amount: 750, exclude_unexcused_absence: false });
    const [entry] = table("audit_logs").filter((row) => row.module === "early_bird_incentive");
    expect(entry).toMatchObject({ actor_role: "hr", metadata: expect.objectContaining({ changed_by_role: "hr" }) });
    expect(entry.description).toMatch(/\(HR\)\.$/);
  });

  it("Admin views only: its change is refused", async () => {
    expect((await (await GET(as("admin"))).json())).toMatchObject({ can_edit_settings: false, can_edit_amount: false });
    expect((await PATCH(as("admin", "PATCH", { threshold_minutes: 5 }))).status).toBe(403);
    expect(table("system_config").find((row) => row.key === "threshold_minutes").value).toBe("15");
  });
});

describe("The per-day Early Bird bonus is retired", () => {
  it("is no longer a rate the configuration offers or accepts", async () => {
    const { RATE_TYPES, DEFAULT_RATES, validateRateInput } = await import("@/lib/payroll/rates");
    expect(RATE_TYPES.early_bird_bonus).toBeUndefined();
    expect(DEFAULT_RATES.early_bird_bonus).toBeUndefined();
    expect(validateRateInput({ rate_type: "early_bird_bonus", scope: "global", value: 20, effective_date: "2026-11-01" })).toBe("Unknown rate type.");
  });
});
