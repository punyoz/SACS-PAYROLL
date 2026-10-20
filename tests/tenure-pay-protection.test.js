/**
 * Tenure Pay Protection
 * (supabase/migrations/20261015010000_tenure_pay_protection.sql,
 * src/lib/payroll/tenure-protection.js, /api/hr/tenure-protection, payroll).
 *
 * The SQL side (guards, trigger, functions) has its own scenarios:
 * scripts/checks/tenure-pay-protection-scenarios.sql.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { computeAttendancePay } from "@/lib/payroll/attendance-pay";
import {
  addMonths,
  breakKindOn,
  buildProtection,
  categoryFor,
  eligibleFrom,
  meetsTenure,
  policyFor,
  schoolYearOf,
  tenureYears,
  validateBreakInput,
  validatePolicyInput,
} from "@/lib/payroll/tenure-protection";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

afterEach(() => {
  vi.useRealTimers();
});

const BRANCH = "bbbbbbbb-0000-4000-8000-00000000000a";
const OTHER_BRANCH = "bbbbbbbb-0000-4000-8000-00000000000b";

const policyRow = (fields = {}) => ({
  id: fields.branch_id ? `pol-${fields.branch_id}` : "pol-system",
  branch_id: null, use_global: false, min_tenure_years: 2,
  cover_absence: true, cover_late: true, cover_holiday: true, cover_suspension: true,
  cover_summer_break: true, cover_christmas_break: true, is_active: true,
  ...fields,
});
const grantRow = (id, employeeId, fields = {}) => ({
  id, employee_id: employeeId, effective_from: "2026-09-01", notes: "Contract 2023-01",
  granted_by: "u-hr", granted_by_name: "Hana HR", granted_by_role: "hr", granted_at: "2026-09-01T01:00:00Z",
  revoked_on: null, ...fields,
});
const breakRow = (kind, start, end, fields = {}) => ({
  id: `brk-${kind}`, school_year: "2026-2027", kind, start_date: start, end_date: end, archived: false, ...fields,
});

/* ── Tenure ─────────────────────────────────────────────────────────────── */

describe("Tenure threshold", () => {
  it("an employee under 2 years does not qualify; at exactly 2 years they do", () => {
    expect(meetsTenure("2025-06-01", "2026-10-14", 2)).toBe(false);
    expect(meetsTenure("2024-10-14", "2026-10-13", 2)).toBe(false);
    expect(meetsTenure("2024-10-14", "2026-10-14", 2)).toBe(true);
    expect(eligibleFrom("2025-06-01", 2)).toBe("2027-06-01");
    expect(meetsTenure(null, "2026-10-14", 2)).toBe(false);
  });

  it("changing the threshold changes who qualifies", () => {
    expect(meetsTenure("2023-06-01", "2026-10-14", 2)).toBe(true);
    expect(meetsTenure("2023-06-01", "2026-10-14", 3)).toBe(true);
    expect(meetsTenure("2023-06-01", "2026-10-14", 4)).toBe(false);
    expect(meetsTenure("2025-06-01", "2026-10-14", 1)).toBe(true);
    // Half years count in months.
    expect(eligibleFrom("2024-06-01", 2.5)).toBe("2026-12-01");
  });

  it("counts like Postgres: a Feb 29 hire reaches the anniversary on Feb 28", () => {
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2024-02-29", 48)).toBe("2028-02-29");
    expect(tenureYears("2023-06-01", "2026-10-14")).toBe(3.3);
    expect(tenureYears("2026-11-01", "2026-10-14")).toBe(0);
  });

  it("a branch's own policy wins unless it follows the system-wide one", () => {
    const rows = [policyRow(), policyRow({ branch_id: BRANCH, min_tenure_years: 5 })];
    expect(policyFor(rows, BRANCH)).toMatchObject({ min_tenure_years: 5, source: "branch" });
    expect(policyFor(rows, OTHER_BRANCH)).toMatchObject({ min_tenure_years: 2, source: "system" });
    rows[1].use_global = true;
    expect(policyFor(rows, BRANCH)).toMatchObject({ min_tenure_years: 2, source: "system" });
    expect(policyFor([], BRANCH)).toMatchObject({ min_tenure_years: 2, source: "default", is_active: true });
  });
});

/* ── Break periods ──────────────────────────────────────────────────────── */

describe("Summer and Christmas break periods", () => {
  it("finds the break a date falls in; an archived break is ignored", () => {
    const breaks = [breakRow("christmas", "2026-12-19", "2027-01-04"), breakRow("summer", "2027-04-01", "2027-05-31")];
    expect(breakKindOn(breaks, "2026-12-25")).toBe("christmas");
    expect(breakKindOn(breaks, "2027-01-05")).toBeNull();
    expect(breakKindOn(breaks, "2027-04-15")).toBe("summer");
    breaks[1].archived = true;
    expect(breakKindOn(breaks, "2027-04-15")).toBeNull();
  });

  it("validates a break for its school year", () => {
    expect(schoolYearOf("2026-10-14")).toBe("2026-2027");
    expect(schoolYearOf("2027-04-20")).toBe("2026-2027");
    expect(validateBreakInput({ school_year: "2026-2027", kind: "christmas", start_date: "2026-12-19", end_date: "2027-01-04" }).value)
      .toMatchObject({ kind: "christmas", start_date: "2026-12-19", end_date: "2027-01-04" });
    expect(validateBreakInput({ school_year: "2026-2027", kind: "summer", start_date: "2027-05-01", end_date: "2027-04-01" }).error).toMatch(/before its first day/);
    expect(validateBreakInput({ school_year: "2026-2027", kind: "summer", start_date: "2025-04-01", end_date: "2025-05-01" }).error).toMatch(/must fall between/);
    expect(validateBreakInput({ school_year: "2026-2028", kind: "summer", start_date: "2027-04-01", end_date: "2027-05-01" }).error).toMatch(/school year/);
    expect(validateBreakInput({ school_year: "2026-2027", kind: "summer", start_date: "2027-01-01", end_date: "2027-07-01" }).error).toMatch(/at most/);
  });

  it("validates the policy form", () => {
    expect(validatePolicyInput({ min_tenure_years: 2.5, categories: { absence: true, summer_break: false } }).value)
      .toMatchObject({ min_tenure_years: 2.5, cover_absence: true, cover_summer_break: false, cover_late: false, is_active: true });
    expect(validatePolicyInput({ min_tenure_years: -1 }).error).toMatch(/between 0 and 50/);
    expect(validatePolicyInput({ min_tenure_years: "" }).error).toMatch(/between 0 and 50/);
  });
});

/* ── The payroll engine with protection ─────────────────────────────────── */

describe("computeAttendancePay with Tenure Pay Protection", () => {
  // Daily ₱2,400, hourly ₱300, late ₱5 a minute (100% of the hourly rate).
  const rates = { hourly: 300, daily: 2400, half_day_pct: 50, absent_pct: 100, late_days_per_absent: 0, late_minute_charge_pct: 100, perfect_attendance_bonus: 500 };
  const holidays = new Map([["2026-10-06", "special"]]);
  holidays.names = new Map([["2026-10-05", "Typhoon"], ["2026-10-06", "Special day"]]);
  holidays.partialDays = new Set(["2026-10-05"]);
  const holidayTypes = new Map([["2026-10-05", "suspension"], ["2026-10-06", "special"]]);
  const breaks = [breakRow("summer", "2026-10-07", "2026-10-08"), breakRow("christmas", "2026-10-09", "2026-10-09")];
  const log = (id, date, fields = {}) => ({
    id, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`,
    status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, ...fields,
  });
  const absent = (id, date) => log(id, date, { time_in: null, time_out: null, status: "Absent" });
  const logs = [
    absent("l1", "2026-10-01"),                                      // absence
    log("l2", "2026-10-02", { status: "Late", late_minutes: 20 }),   // late: ₱100
    absent("l5", "2026-10-05"),                                      // morning suspension: half
    log("l6", "2026-10-06", { status: "Late", late_minutes: 10 }),   // worked holiday, late: ₱50
    absent("l7", "2026-10-07"),                                      // summer break
    absent("l8", "2026-10-08"),                                      // summer break
    absent("l9", "2026-10-09"),                                      // Christmas break
    log("l12", "2026-10-12", { status: "Undertime", undertime_minutes: 30 }), // not a covered category
  ];
  const run = (protection) => computeAttendancePay({
    logs, rates, periodStart: "2026-10-01", periodEnd: "2026-10-15", holidays, protection,
  });
  const protectionFor = ({ hired = "2023-06-01", policy = {}, grants = [grantRow("g-ana", "ana")], breakRows = breaks } = {}) => buildProtection({
    employee: { id: "ana", branch_id: BRANCH, date_hired: hired },
    policies: [policyRow(policy)],
    grants,
    breaks: breakRows,
    holidayTypeOn: (key) => holidayTypes.get(key) || null,
  });

  it("puts each day in its category: break and calendar days first, then the deduction", () => {
    expect(categoryFor({ breakKind: "summer", holidayType: "special" }, "absent")).toBe("summer_break");
    expect(categoryFor({ holidayType: "suspension" }, "late")).toBe("suspension");
    expect(categoryFor({ holidayType: "holiday" }, "undertime")).toBe("holiday");
    expect(categoryFor({}, "half_day")).toBe("absence");
    expect(categoryFor({}, "late")).toBe("late");
    expect(categoryFor({}, "undertime")).toBeNull();
  });

  it("without protection the deductions are exactly as before", () => {
    const pay = run(undefined);
    expect(pay.amounts).toMatchObject({ absent: 2400 + 1200 + 2400 * 3, late: 150, undertime: 150 });
    expect(pay.protected).toBeUndefined();
    expect(pay.counts.protected_absent_days).toBeUndefined();
  });

  it("an employee under 2 years, even with a grant on file, is deducted normally", () => {
    const protection = protectionFor({ hired: "2025-06-01" });
    const pay = run(protection);
    expect(pay.amounts).toMatchObject({ absent: 10800, late: 150, undertime: 150 });
    expect(pay.protected).toEqual([]);
  });

  it("over 2 years but NOT granted: deducted normally, summer and Christmas break days unpaid", () => {
    expect(protectionFor({ grants: [] })).toBeNull();
    const pay = run(protectionFor({ grants: [grantRow("g-ben", "ben")] }) || undefined);
    expect(pay.amounts).toMatchObject({ absent: 10800, late: 150, undertime: 150 });
  });

  it("over 2 years AND granted: absence, late, holiday, suspension, summer and Christmas break all paid", () => {
    const pay = run(protectionFor());
    expect(pay.amounts).toMatchObject({ absent: 0, late: 0, half_day: 0, undertime: 150 });
    expect(pay.counts).toMatchObject({ absent_days: 0, late_days: 0, late_minutes: 0, protected_absent_days: 4.5, protected_late_days: 2, protected_late_minutes: 30 });
    expect(pay.protected.map((l) => [l.log_date, l.type, l.category, l.amount])).toEqual([
      ["2026-10-01", "absent", "absence", 2400],
      ["2026-10-02", "late", "late", 100],
      ["2026-10-05", "absent", "suspension", 1200],
      ["2026-10-06", "late", "holiday", 50],
      ["2026-10-07", "absent", "summer_break", 2400],
      ["2026-10-08", "absent", "summer_break", 2400],
      ["2026-10-09", "absent", "christmas_break", 2400],
    ]);
    expect(pay.protected.every((l) => l.grant_id === "g-ana" && l.source_log_id)).toBe(true);
    expect(pay.protected_amount).toBe(10950);
    // Waived misses are still misses.
    expect(pay.perfect_attendance).toBe(false);
  });

  it("only the configured categories are protected: summer break unchecked stays unpaid, even with absence covered", () => {
    const pay = run(protectionFor({ policy: { cover_summer_break: false } }));
    expect(pay.amounts.absent).toBe(4800); // Oct 7 and 8
    expect(pay.protected.map((l) => l.category)).not.toContain("summer_break");
    expect(pay.protected.map((l) => l.log_date)).toEqual(expect.arrayContaining(["2026-10-01", "2026-10-09"]));
  });

  it("each category can be switched off on its own", () => {
    const pay = run(protectionFor({ policy: { cover_late: false, cover_holiday: false, cover_suspension: false, cover_christmas_break: false } }));
    // Oct 1 (absence) and Oct 7-8 (summer) waived; the rest deducted.
    expect(pay.amounts).toMatchObject({ absent: 1200 + 2400, late: 150 });
    expect(pay.protected.map((l) => l.log_date)).toEqual(["2026-10-01", "2026-10-07", "2026-10-08"]);
  });

  it("an inactive policy protects nobody", () => {
    expect(protectionFor({ policy: { is_active: false } })).toBeNull();
  });

  it("raising the threshold above the employee's tenure stops the protection", () => {
    expect(run(protectionFor({ policy: { min_tenure_years: 3 } })).amounts.absent).toBe(0);
    expect(run(protectionFor({ policy: { min_tenure_years: 4 } })).amounts.absent).toBe(10800);
  });

  it("changing the break dates moves which days payroll treats as break days", () => {
    const summerOnly = { cover_absence: false, cover_late: false, cover_holiday: false, cover_suspension: false, cover_christmas_break: false };
    const before = run(protectionFor({ policy: summerOnly, breakRows: [breakRow("summer", "2026-10-07", "2026-10-08")] }));
    expect(before.protected.map((l) => l.log_date)).toEqual(["2026-10-07", "2026-10-08"]);
    const after = run(protectionFor({ policy: summerOnly, breakRows: [breakRow("summer", "2026-10-08", "2026-10-09")] }));
    expect(after.protected.map((l) => l.log_date)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(after.amounts.absent).toBe(2400 + 1200 + 2400); // Oct 1, Oct 5 half, Oct 7
  });

  it("a revoked grant protects the days before revoked_on only", () => {
    const pay = run(protectionFor({ grants: [grantRow("g-ana", "ana", { revoked_on: "2026-10-07" })] }));
    expect(pay.protected.map((l) => l.log_date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"]);
    expect(pay.amounts.absent).toBe(2400 * 3);
  });

  it("a grant starting later does not protect earlier days", () => {
    const pay = run(protectionFor({ grants: [grantRow("g-ana", "ana", { effective_from: "2026-10-07" })] }));
    expect(pay.protected.map((l) => l.log_date)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
  });
});

/* ── The HR API ─────────────────────────────────────────────────────────── */

describe("GET / POST /api/hr/tenure-protection", () => {
  const ANA = "cccccccc-0000-4000-8000-00000000000a";  // hired 2023, Main
  const BEN = "cccccccc-0000-4000-8000-00000000000b";  // hired 2023, Main
  const CARA = "cccccccc-0000-4000-8000-00000000000c"; // hired 2025, Main
  const DAN = "cccccccc-0000-4000-8000-00000000000d";  // hired 2022, Annex
  let GET;
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;

  const as = (role, method = "GET", body = null) => new Request("https://sacs.test/api/hr/tenure-protection", {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: `u-${role}`, role, branch_id: role === "super_admin" || role === "hr" ? null : BRANCH, email: `${role}@sacs.test`, full_name: `${role} user`, session_id: `s-${role}` })}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const post = async (role, body) => {
    const response = await POST(as(role, "POST", body));
    return { status: response.status, body: await response.json() };
  };
  const get = async (role) => {
    const response = await GET(as(role));
    return { status: response.status, body: await response.json() };
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T09:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-tenure";
    resetDb();
    table("branches").push({ id: BRANCH, name: "Main" }, { id: OTHER_BRANCH, name: "Annex" });
    table("profiles").push(
      { id: "u-hr", role: "hr", branch_id: null },
      { id: "u-admin", role: "admin", branch_id: BRANCH },
      { id: "u-super_admin", role: "super_admin", branch_id: null },
      { id: "u-accountant", role: "accountant", branch_id: BRANCH },
      { id: "u-employee", role: "employee", branch_id: BRANCH },
      { id: ANA, full_name: "Ana Reyes", employee_id: "SACS-001", branch_id: BRANCH, role: "employee", archived: false, date_hired: "2023-06-01" },
      { id: BEN, full_name: "Ben Cruz", employee_id: "SACS-002", branch_id: BRANCH, role: "employee", archived: false, date_hired: "2023-06-01" },
      { id: CARA, full_name: "Cara Lim", employee_id: "SACS-003", branch_id: BRANCH, role: "accountant", archived: false, date_hired: "2025-06-01" },
      { id: DAN, full_name: "Dan Santos", employee_id: "SACS-004", branch_id: OTHER_BRANCH, role: "employee", archived: false, date_hired: "2022-01-10" },
    );
    table("tenure_protection_policies").push(policyRow());
    table("tenure_protection_grants").push(grantRow("dddddddd-0000-4000-8000-00000000000b", BEN));
    ({ GET, POST } = await import("@/app/api/hr/tenure-protection/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("Employees and Accountants can neither see nor change it", async () => {
    for (const role of ["employee", "accountant"]) {
      expect((await get(role)).status).toBe(403);
      expect((await post(role, { action: "grant", employee_id: ANA })).status).toBe(403);
      expect((await post(role, { action: "save_policy", min_tenure_years: 0, categories: {} })).status).toBe(403);
    }
    expect(table("tenure_protection_grants")).toHaveLength(1);
  });

  it("lists who MEETS the tenure separately from who HAS the benefit", async () => {
    const { status, body } = await get("hr");
    expect(status).toBe(200);
    const by = Object.fromEntries(body.employees.map((e) => [e.full_name, e]));
    expect(by["Ana Reyes"]).toMatchObject({ meets_tenure: true, grant: null, protected_today: false, tenure_years: 3.3 });
    expect(by["Ben Cruz"]).toMatchObject({ meets_tenure: true, protected_today: true, grant: { granted_by_name: "Hana HR", notes: "Contract 2023-01" } });
    expect(by["Cara Lim"]).toMatchObject({ meets_tenure: false, eligible_from: "2027-06-01" });
    expect(by["Dan Santos"]).toMatchObject({ meets_tenure: true, branch_name: "Annex" });
    expect(body).toMatchObject({ can_edit: true, can_edit_system: true, school_year: "2026-2027" });
  });

  // 2026-10-20: Tenure Pay Protection is HR's alone.
  it("the Admin and the Super Admin have no access", async () => {
    expect((await get("admin")).status).toBe(403);
    expect((await get("super_admin")).status).toBe(403);
  });

  it("HR grants to an eligible employee, with the contract reference; the audit log names HR", async () => {
    const result = await post("hr", { action: "grant", employee_id: ANA, effective_from: "2026-10-14", notes: "Contract No. 2023-014" });
    expect(result.status).toBe(200);
    const saved = table("tenure_protection_grants").find((g) => g.employee_id === ANA);
    expect(saved).toMatchObject({ effective_from: "2026-10-14", notes: "Contract No. 2023-014", granted_by: "u-hr", granted_by_role: "hr" });
    expect(saved.revoked_on ?? null).toBeNull();
    const [entry] = table("audit_logs").filter((row) => row.module === "tenure_protection");
    expect(entry.action).toBe("grant");
    expect(entry.description).toMatch(/granted to Ana Reyes from 2026-10-14 \(Contract No\. 2023-014\), by hr user \(HR\)/);
  });

  it("refuses to grant to an employee under the tenure threshold", async () => {
    const result = await post("hr", { action: "grant", employee_id: CARA });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/does not meet the 2-year tenure requirement.*eligible from 2027-06-01/);
    expect(table("tenure_protection_grants")).toHaveLength(1);
  });

  it("refuses a second open grant and a start date in the past", async () => {
    expect((await post("hr", { action: "grant", employee_id: BEN })).status).toBe(409);
    expect((await post("hr", { action: "grant", employee_id: ANA, effective_from: "2026-10-01" })).body.error).toMatch(/cannot be before today/);
  });

  it("the Admin grants nothing and changes no policy or break dates (HR only)", async () => {
    expect((await post("admin", { action: "grant", employee_id: ANA, notes: "Contract 7" })).status).toBe(403);
    expect((await post("admin", { action: "save_policy", branch_id: BRANCH, min_tenure_years: 3, categories: { absence: true } })).status).toBe(403);
    expect((await post("admin", { action: "save_break", school_year: "2026-2027", kind: "christmas", start_date: "2026-12-19", end_date: "2027-01-04" })).status).toBe(403);
    expect((await post("super_admin", { action: "grant", employee_id: ANA, notes: "Contract 7" })).status).toBe(403);
    expect(table("tenure_protection_grants").find((g) => g.employee_id === ANA && g.notes === "Contract 7")).toBeUndefined();
  });

  it("changing the tenure threshold updates who meets it", async () => {
    expect((await post("hr", { action: "save_policy", branch_id: null, min_tenure_years: 1, categories: { absence: true, late: true }, is_active: true })).status).toBe(200);
    let by = Object.fromEntries((await get("hr")).body.employees.map((e) => [e.full_name, e.meets_tenure]));
    expect(by).toMatchObject({ "Cara Lim": true, "Ana Reyes": true });
    await post("hr", { action: "save_policy", branch_id: null, min_tenure_years: 4, categories: { absence: true }, is_active: true });
    by = Object.fromEntries((await get("hr")).body.employees.map((e) => [e.full_name, e]));
    expect(by["Ana Reyes"].meets_tenure).toBe(false);
    expect(by["Dan Santos"].meets_tenure).toBe(true);
    // Ben keeps his grant, but below the tenure it no longer protects him.
    expect(by["Ben Cruz"]).toMatchObject({ meets_tenure: false, protected_today: false, grant: expect.any(Object) });
  });

  it("HR sets and changes the break dates per school year", async () => {
    expect((await post("hr", { action: "save_break", school_year: "2026-2027", kind: "christmas", start_date: "2026-12-19", end_date: "2027-01-04" })).status).toBe(200);
    expect((await post("hr", { action: "save_break", school_year: "2026-2027", kind: "summer", start_date: "2026-12-20", end_date: "2027-01-10" })).status).toBe(409);
    expect((await post("hr", { action: "save_break", school_year: "2026-2027", kind: "christmas", start_date: "2026-12-21", end_date: "2027-01-03" })).status).toBe(200);
    expect(table("school_break_periods")).toHaveLength(1);
    expect(table("school_break_periods")[0]).toMatchObject({ start_date: "2026-12-21", end_date: "2027-01-03", updated_by: "u-hr" });
    expect((await post("hr", { action: "archive_break", school_year: "2026-2027", kind: "christmas" })).status).toBe(200);
    expect(table("school_break_periods")[0].archived).toBe(true);
  });

  it("revoking ends protection from today or later, never earlier", async () => {
    const id = "dddddddd-0000-4000-8000-00000000000b";
    expect((await post("hr", { action: "revoke", grant_id: id, revoked_on: "2026-10-01" })).body.error).toMatch(/cannot be before today/);
    const result = await post("hr", { action: "revoke", grant_id: id, notes: "Contract ended" });
    expect(result.status).toBe(200);
    expect(table("tenure_protection_grants")[0]).toMatchObject({ revoked_on: "2026-10-14", revoked_by: "u-hr", revoked_by_role: "hr", revoke_notes: "Contract ended" });
    expect((await post("hr", { action: "revoke", grant_id: id })).status).toBe(409);
  });
});

/* ── Payroll through the route ──────────────────────────────────────────── */

describe("Payroll with Tenure Pay Protection", () => {
  const ANA = "u-ana";   // hired 2023, GRANTED
  const BEN = "u-ben";   // hired 2023, not granted
  const CARA = "u-cara"; // hired 2025, granted on file but under 2 years
  const FIRST = "October 1-15, 2026";
  const LEGAL = {
    sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000,
    philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000,
  };
  const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
    id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
  });
  const log = (id, employeeId, date, fields = {}) => ({
    id, employee_id: employeeId, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`, created_at: `${date}T00:00:00Z`,
    status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false,
    arrival_offset_minutes: 0, ...fields,
  });
  const daysOf = (employeeId, prefix) => [
    log(`${prefix}1`, employeeId, "2026-10-01", { time_in: null, time_out: null, status: "Absent" }),
    log(`${prefix}2`, employeeId, "2026-10-02", { status: "Late", late_minutes: 20, arrival_offset_minutes: 20 }),
    log(`${prefix}7`, employeeId, "2026-10-07", { time_in: null, time_out: null, status: "Absent" }),
    log(`${prefix}8`, employeeId, "2026-10-08", { time_in: null, time_out: null, status: "Absent" }),
    log(`${prefix}12`, employeeId, "2026-10-12", { status: "Undertime", undertime_minutes: 30 }),
  ];
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
    process.env.SESSION_SECRET = "test-secret-tenure-payroll";
    resetDb();
    users.push(
      { id: ANA, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Reyes", employee_id: "SACS-001", basic_salary: 52200, branch_id: BRANCH } },
      { id: BEN, email: "ben@sacs.test", user_metadata: { role: "employee", full_name: "Ben Cruz", employee_id: "SACS-002", basic_salary: 52200, branch_id: BRANCH } },
      { id: CARA, email: "cara@sacs.test", user_metadata: { role: "employee", full_name: "Cara Lim", employee_id: "SACS-003", basic_salary: 52200, branch_id: BRANCH } },
    );
    table("profiles").push(
      { id: "u-acct", branch_id: BRANCH },
      { id: ANA, full_name: "Ana Reyes", email: "ana@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-001", archived: false, date_hired: "2023-06-01" },
      { id: BEN, full_name: "Ben Cruz", email: "ben@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-002", archived: false, date_hired: "2023-06-01" },
      { id: CARA, full_name: "Cara Lim", email: "cara@sacs.test", branch_id: BRANCH, role: "employee", employee_id: "SACS-003", archived: false, date_hired: "2025-06-01" },
    );
    // Salary 52,200: daily 2,400, hourly 300; late and undertime ₱5 a minute.
    table("payroll_rate_configs").push(
      rate("hourly", 68.75), rate("daily", 550), rate("half_day_pct", 50), rate("absent_pct", 100),
      rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 100), rate("perfect_attendance_bonus", 0),
      ...Object.entries({ ...LEGAL, overtime_premium_pct: 25, regular_holiday_premium_pct: 100, special_holiday_premium_pct: 30, working_days_per_year: 261 })
        .map(([type, value]) => rate(type, value, "2026-10-01")),
    );
    table("tenure_protection_policies").push(policyRow());
    table("tenure_protection_grants").push(grantRow("g-ana", ANA), grantRow("g-cara", CARA));
    // A (test) summer break on Oct 7-8.
    table("school_break_periods").push(breakRow("summer", "2026-10-07", "2026-10-08"));
    table("attendance_logs").push(...daysOf(ANA, "a"), ...daysOf(BEN, "b"), ...daysOf(CARA, "c"));
    ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  const preview = async () => {
    const body = await (await GET(request("GET", null, `?period=${encodeURIComponent(FIRST)}`))).json();
    return Object.fromEntries(body.attendance_rows.map((row) => [row.employee_id, row.pay]));
  };

  it("granted and over 2 years: absence, late and summer break days are paid; undertime is still deducted", async () => {
    const pay = await preview();
    expect(pay[ANA].amounts).toMatchObject({ absent: 0, late: 0, undertime: 150 });
    expect(pay[ANA].tenure_protection.map((l) => [l.log_date, l.category, l.grant_id])).toEqual([
      ["2026-10-01", "absence", "g-ana"], ["2026-10-02", "late", "g-ana"],
      ["2026-10-07", "summer_break", "g-ana"], ["2026-10-08", "summer_break", "g-ana"],
    ]);
    expect(pay[ANA].tenure_protection_amount).toBe(2400 + 100 + 4800);
  });

  it("not granted, or granted but under 2 years: deducted, and summer break days unpaid", async () => {
    const pay = await preview();
    for (const id of [BEN, CARA]) {
      expect(pay[id].amounts).toMatchObject({ absent: 7200, late: 100, undertime: 150 });
      expect(pay[id].tenure_protection || []).toEqual([]);
    }
  });

  it("the payslip records each waived deduction with its grant, for the audit trail", async () => {
    const response = await POST(request("POST", { action: "batch_submit", pay_period: FIRST, entries: [{ employee_id: ANA }, { employee_id: BEN }] }));
    expect(response.status).toBe(200);
    const ana = table("payroll_entries").find((e) => e.employee_id === ANA);
    const ben = table("payroll_entries").find((e) => e.employee_id === BEN);
    expect(ana.payroll.totals).toMatchObject({ absence_deduction: 0, late_deduction: 0, undertime_deduction: 150 });
    expect(ben.payroll.totals).toMatchObject({ absence_deduction: 7200, late_deduction: 100, undertime_deduction: 150 });
    expect(ana.payroll.audit.attendance.tenure_protection).toHaveLength(4);
    expect(ana.payroll.audit.attendance.tenure_protection[0]).toMatchObject({ type: "absent", category: "absence", grant_id: "g-ana", source_log_id: "a1", amount: 2400 });
    expect(ben.payroll.audit.attendance.tenure_protection).toBeUndefined();
    // No deduction lines for what was waived.
    expect(table("payroll_deductions").filter((l) => l.employee_id === ANA).map((l) => l.type)).toEqual(["undertime"]);
  });

  it("picks up changed break dates", async () => {
    table("tenure_protection_policies")[0].cover_absence = false;
    let pay = await preview();
    expect(pay[ANA].tenure_protection.map((l) => l.log_date)).toEqual(["2026-10-02", "2026-10-07", "2026-10-08"]);
    table("school_break_periods")[0].start_date = "2026-10-08";
    pay = await preview();
    expect(pay[ANA].tenure_protection.map((l) => l.log_date)).toEqual(["2026-10-02", "2026-10-08"]);
    expect(pay[ANA].amounts.absent).toBe(4800); // Oct 1 and Oct 7 are ordinary absences now
  });

  it("summer break unchecked: still unpaid in summer, other categories still protected", async () => {
    table("tenure_protection_policies")[0].cover_summer_break = false;
    const pay = await preview();
    expect(pay[ANA].amounts).toMatchObject({ absent: 4800, late: 0 });
  });

  it("revoking stops protection going forward without changing the payslip already processed", async () => {
    await POST(request("POST", { action: "batch_submit", pay_period: FIRST, entries: [{ employee_id: ANA }] }));
    const before = JSON.parse(JSON.stringify(table("payroll_entries").find((e) => e.employee_id === ANA)));
    // HR revokes from Oct 8.
    table("tenure_protection_grants")[0].revoked_on = "2026-10-08";
    expect(table("payroll_entries").find((e) => e.employee_id === ANA)).toEqual(before);
    // Worked out again, days before Oct 8 keep their protection; Oct 8 does not.
    const pay = await preview();
    expect(pay[ANA].tenure_protection.map((l) => l.log_date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-07"]);
    expect(pay[ANA].amounts.absent).toBe(2400);
  });
});
