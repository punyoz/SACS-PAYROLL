/**
 * Rate chain check (2026-10-26): monthly salary → daily → hourly → every
 * deduction, through the real Accountant payroll route, for November 2026
 * (the next month not yet processed) with the LIVE rate rows of 2026-10-26:
 *
 *   working days per year 261 · global daily ₱600 (Oct 1) · global hourly
 *   ₱72 (Oct 16, set on its own) · late charge 0% and late-days rule off ·
 *   contributions as fixed amounts on the 16-end payslip (from Oct 16:
 *   SSS ₱300, PhilHealth ₱400, Pag-IBIG ₱400) · BIR 2023 monthly table.
 *
 * One difference from live, on purpose: the lock day is the month end (no
 * payslip schedule row), so each half's window is its own 1-15 / 16-30.
 *
 * Daily = 18,000 × 12 ÷ 261 = 827.586… → ₱827.59; hourly = 827.59 ÷ 8 =
 * 103.44875 → ₱103.45. Set PRINT_RATE_CHAIN=1 to print every figure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { resolveRates } from "@/lib/payroll/rates";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const FIRST = "November 1-15, 2026";
const SECOND = "November 16-30, 2026";
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];

const rate = (rateType, value, effectiveDate = "2026-01-01", createdAt = `${effectiveDate}T00:00:00Z`) => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: createdAt,
});

// payroll_rate_configs as on live, 2026-10-26.
const LIVE_RATES = [
  rate("hourly", 68.75), rate("hourly", 75, "2026-10-01", "2026-09-28T05:28:58Z"), rate("hourly", 72, "2026-10-16", "2026-10-13T08:15:43Z"),
  rate("daily", 550), rate("daily", 600, "2026-10-01", "2026-09-28T05:27:30Z"),
  rate("half_day_pct", 50), rate("absent_pct", 100),
  rate("late_days_per_absent", 3), rate("late_days_per_absent", 0, "2026-10-01"),
  rate("late_minute_charge_pct", 0), rate("perfect_attendance_bonus", 0),
  rate("sss_pct", 5, "2026-10-01"), rate("philhealth_pct", 2.5, "2026-10-01"), rate("pagibig_pct", 2, "2026-10-01"),
  rate("sss_msc_min", 5000, "2026-10-01"), rate("sss_msc_max", 35000, "2026-10-01"),
  rate("philhealth_floor", 10000, "2026-10-01"), rate("philhealth_ceiling", 100000, "2026-10-01"), rate("pagibig_max_salary", 10000, "2026-10-01"),
  rate("overtime_premium_pct", 25, "2026-10-01"), rate("regular_holiday_premium_pct", 100, "2026-10-01"), rate("special_holiday_premium_pct", 30, "2026-10-01"),
  rate("working_days_per_year", 261, "2026-10-01"),
  rate("attendance_lock_day", 0, "2026-10-01"), rate("carry_after_lock", 1, "2026-10-01"),
  rate("payroll_per_half", 0, "2026-10-01"), rate("contribution_method", 1, "2026-10-01"), rate("contribution_half", 2, "2026-10-01"),
  rate("sss_fixed", 400, "2026-10-01"), rate("sss_fixed", 300, "2026-10-16"),
  rate("philhealth_fixed", 0, "2026-10-01"), rate("philhealth_fixed", 400, "2026-10-16"),
  rate("pagibig_fixed", 200, "2026-10-01"), rate("pagibig_fixed", 400, "2026-10-16"),
  rate("overload_premium_pct", 0, "2026-10-01"),
];

const PEOPLE = [
  { id: "u-ana", name: "Ana Perfect", code: "SACS-101", salary: 18000 },
  { id: "u-ben", name: "Ben Absent 1st Half", code: "SACS-102", salary: 18000 },
  { id: "u-cara", name: "Cara Undertime", code: "SACS-103", salary: 18000 },
  { id: "u-dan", name: "Dan Tenure", code: "SACS-104", salary: 18000, hired: "2020-06-01" },
  { id: "u-eva", name: "Eva Leave", code: "SACS-105", salary: 18000 },
  { id: "u-fe", name: "Fe Taxed", code: "SACS-106", salary: 30000 },
];

const log = (id, employeeId, date, fields = {}) => ({
  id, employee_id: employeeId, branch_id: BRANCH, log_date: date, time_in: `${date}T00:00:00Z`, time_out: `${date}T09:00:00Z`, created_at: `${date}T00:00:00Z`,
  status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false,
  arrival_offset_minutes: 0, ...fields,
});
const absent = (id, employeeId, date) => log(id, employeeId, date, { status: "Absent", time_in: null, time_out: null, arrival_offset_minutes: null });

let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;
const request = (method, body, query = "") => new Request(`https://sacs.test/api/accountant/payroll${query}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: "u-acct", role: "accountant", branch_id: BRANCH, email: "acct@sacs.test", full_name: "Pay Accountant", session_id: "s-1" })}`,
  },
  body: body ? JSON.stringify(body) : undefined,
});

const entry = (employeeId, label) => table("payroll_entries").find((e) => e.employee_id === employeeId && e.pay_period === label);

/** The figures to verify by hand, per employee. */
function figures(id) {
  const first = entry(id, FIRST)?.payroll;
  const second = entry(id, SECOND)?.payroll;
  const m = second?.monthly || {};
  return {
    rates: { daily: second?.audit?.rates?.daily?.value, hourly: second?.audit?.rates?.hourly?.value, hourly_source: second?.audit?.rates?.hourly?.source },
    first_half: {
      basic: first?.basic_salary, absence: first?.totals?.absence_deduction, late: first?.totals?.late_deduction,
      undertime: first?.totals?.undertime_deduction, lwop: first?.totals?.leave_without_pay_deduction,
      sss: first?.deductions?.sss, philhealth: first?.deductions?.philhealth, pagibig: first?.deductions?.pagibig, tax: first?.deductions?.withholding_tax,
      net: first?.totals?.net_pay,
    },
    second_half: {
      absence: second?.totals?.absence_deduction, late: second?.totals?.late_deduction, undertime: second?.totals?.undertime_deduction,
      lwop: second?.totals?.leave_without_pay_deduction, sss: second?.deductions?.sss, philhealth: second?.deductions?.philhealth,
      pagibig: second?.deductions?.pagibig, tax: second?.deductions?.withholding_tax, incentives: m.incentives, net: second?.totals?.net_pay,
    },
    month: {
      salary: m.monthly_salary, attendance: m.attendance_deductions, gross: m.monthly_gross, contributions: m.contributions,
      taxable: m.taxable_income, tax: m.withholding_tax, net: m.monthly_net, first_half_paid: m.first_half_paid,
    },
    protected: [first, second].flatMap((pay) => pay?.audit?.attendance?.tenure_protection || [])
      .map((l) => ({ date: l.log_date, type: l.type, category: l.category, amount: l.amount, grant: l.grant_id })),
  };
}

describe("Rate chain through payroll, November 2026, live rates", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T10:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-rate-chain";
    resetDb();
    table("profiles").push({ id: "u-acct", branch_id: BRANCH });
    PEOPLE.forEach((p) => {
      users.push({ id: p.id, email: `${p.code}@sacs.test`, user_metadata: { role: "employee", full_name: p.name, employee_id: p.code, basic_salary: p.salary, branch_id: BRANCH } });
      table("profiles").push({
        id: p.id, full_name: p.name, email: `${p.code}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: p.code,
        archived: false, basic_salary: p.salary, date_hired: p.hired || "2024-06-01", position: "Teacher",
      });
    });
    table("payroll_rate_configs").push(...LIVE_RATES);
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
      id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
    })));

    table("attendance_logs").push(
      // Ben: absent Thursday Nov 5 (1st half) only.
      absent("b1", "u-ben", "2026-11-05"),
      // Cara: 25 min late Nov 4 (late charge 0%: nothing), 90 min undertime Nov 18.
      log("c1", "u-cara", "2026-11-04", { status: "Late", late_minutes: 25, arrival_offset_minutes: 25 }),
      log("c2", "u-cara", "2026-11-18", { status: "Undertime", undertime_minutes: 90 }),
      // Dan (Tenure Pay Protection, absence covered): absent Nov 6; undertime 30 min Nov 19 (not a covered category).
      absent("d1", "u-dan", "2026-11-06"),
      log("d2", "u-dan", "2026-11-19", { status: "Undertime", undertime_minutes: 30 }),
      // Eva: leave with pay Mon Nov 9, leave without pay Fri Nov 20.
      log("e1", "u-eva", "2026-11-09", { status: "On Leave", time_in: null, time_out: null }),
      log("e2", "u-eva", "2026-11-20", { status: "On Leave", time_in: null, time_out: null }),
    );
    table("leave_requests").push(
      { id: "lv-1", employee_id: "u-eva", status: "approved", pay_status: "with_pay", leave_type: "Sick Leave", start_date: "2026-11-09", end_date: "2026-11-09", submitted_at: "2026-11-03T01:00:00Z" },
      { id: "lv-2", employee_id: "u-eva", status: "approved", pay_status: "without_pay", leave_type: "Personal Leave", start_date: "2026-11-20", end_date: "2026-11-20", submitted_at: "2026-11-10T01:00:00Z" },
    );
    table("tenure_protection_policies").push({
      id: "pol-system", branch_id: null, use_global: false, min_tenure_years: 2, is_active: true,
      cover_absence: true, cover_late: true, cover_holiday: true, cover_suspension: true, cover_summer_break: true, cover_christmas_break: true,
    });
    table("tenure_protection_grants").push({
      id: "g-dan", employee_id: "u-dan", effective_from: "2026-09-01", notes: "Contract 2020-06", granted_by: "u-hr", granted_by_name: "HR Officer",
      granted_by_role: "hr", granted_at: "2026-09-01T01:00:00Z", revoked_on: null,
    });
    // Fe: an incentive filed in November (paid in November) and one dated in
    // November but filed after the lock date, Nov 30 (rolls to December).
    table("payroll_monthly_incentives").push(
      { id: "inc-in", employee_id: "u-fe", item_date: "2026-11-25", kind: "incentive", description: "Coaching", amount: 1000, hours: null, archived: false, created_at: "2026-11-25T02:00:00Z" },
      { id: "inc-late", employee_id: "u-fe", item_date: "2026-11-27", kind: "incentive", description: "Filed late", amount: 700, hours: null, archived: false, created_at: "2026-12-01T02:00:00Z" },
    );

    ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));

    const ids = PEOPLE.map((p) => ({ employee_id: p.id }));
    const first = await POST(request("POST", { action: "batch_submit", pay_period: FIRST, entries: ids }));
    expect(first.status).toBe(200);
    expect((await first.json()).processed).toHaveLength(PEOPLE.length);
    vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
    const second = await POST(request("POST", { action: "batch_submit", pay_period: SECOND, entries: ids }));
    expect(second.status).toBe(200);
    expect((await second.json()).processed).toHaveLength(PEOPLE.length);

    if (process.env.PRINT_RATE_CHAIN) {
      PEOPLE.forEach((p) => console.log(p.name, JSON.stringify(figures(p.id), null, 1)));
    }
  });

  afterEach(() => vi.useRealTimers());

  it("every payslip uses daily = monthly × 12 ÷ 261 and hourly = daily ÷ 8, not the stored ₱600 / ₱72", () => {
    PEOPLE.filter((p) => p.salary === 18000).forEach((p) => {
      expect(figures(p.id).rates, p.name).toEqual({ daily: 827.59, hourly: 103.45, hourly_source: "derived" });
    });
    expect(figures("u-fe").rates).toEqual({ daily: 1379.31, hourly: 172.41, hourly_source: "derived" });
  });

  it("perfect month: the halves sum to the salary less contributions (no tax under ₱20,833)", () => {
    const f = figures("u-ana");
    expect(f.first_half).toMatchObject({ basic: 9000, absence: 0, sss: 0, philhealth: 0, pagibig: 0, tax: 0, net: 9000 });
    expect(f.month).toMatchObject({ salary: 18000, attendance: 0, gross: 18000, contributions: 1100, taxable: 16900, tax: 0, net: 16900 });
    expect(f.second_half).toMatchObject({ sss: 300, philhealth: 400, pagibig: 400, tax: 0, net: 7900 });
    expect(f.first_half.net + f.second_half.net).toBe(18000 - 1100);
  });

  it("an absence in the 1st half is deducted there only, at the daily rate", () => {
    const f = figures("u-ben");
    expect(f.first_half).toMatchObject({ absence: 827.59, net: 8172.41 });
    expect(f.second_half.absence).toBe(0);
    expect(f.month).toMatchObject({ attendance: 827.59, gross: 17172.41, contributions: 1100, taxable: 16072.41, tax: 0 });
    expect(f.first_half.net + f.second_half.net).toBe(18000 - 827.59 - 1100);
  });

  it("undertime at the hourly rate (90 min × 103.45 ÷ 60); lateness charges nothing at 0%", () => {
    const f = figures("u-cara");
    expect(f.first_half).toMatchObject({ late: 0, undertime: 0, net: 9000 });
    expect(f.second_half).toMatchObject({ late: 0, undertime: 155.18 });
    expect(f.first_half.net + f.second_half.net).toBe(18000 - 155.18 - 1100);
  });

  it("Tenure Pay Protection waives the covered absence; uncovered undertime is still deducted", () => {
    const f = figures("u-dan");
    expect(f.first_half).toMatchObject({ absence: 0, net: 9000 });
    expect(f.second_half).toMatchObject({ absence: 0, undertime: 51.73 });
    // The waived day is on record: Nov 6, absence, one daily rate, Dan's grant.
    expect(f.protected).toEqual([{ date: "2026-11-06", type: "absent", category: "absence", amount: 827.59, grant: "g-dan" }]);
    expect(f.first_half.net + f.second_half.net).toBe(18000 - 51.73 - 1100);
  });

  it("leave with pay deducts nothing; leave without pay one daily rate", () => {
    const f = figures("u-eva");
    expect(f.first_half).toMatchObject({ absence: 0, lwop: 0, net: 9000 });
    expect(f.second_half).toMatchObject({ absence: 0, lwop: 827.59 });
    expect(f.month).toMatchObject({ attendance: 827.59, gross: 17172.41 });
    expect(f.first_half.net + f.second_half.net).toBe(18000 - 827.59 - 1100);
  });

  it("tax once, on the whole month; an incentive filed after the lock date waits for December", () => {
    const f = figures("u-fe");
    expect(f.first_half).toMatchObject({ basic: 15000, tax: 0, net: 15000 });
    // 30,000 + 1,000 incentive − 1,100 = 29,900 taxable → (29,900 − 20,833) × 15% = 1,360.05.
    expect(f.month).toMatchObject({ gross: 31000, contributions: 1100, taxable: 29900, tax: 1360.05, net: 28539.95 });
    expect(f.second_half).toMatchObject({ incentives: 1000, tax: 1360.05, net: 13539.95 });
    expect(f.first_half.net + f.second_half.net).toBe(28539.95);
  });
});

describe("Before / after the 2026-10-26 fix (resolveRates)", () => {
  const configs = LIVE_RATES;
  it("an employee with a salary: unchanged, 827.59 / 103.45", () => {
    const r = resolveRates(configs, { employeeId: "x", monthlySalary: 18000 }, "2026-11-16");
    expect([r.daily.value, r.hourly.value]).toEqual([827.59, 103.45]);
  });
  it("no salary on file (the fallback): hourly is now the ₱600 daily ÷ 8 = ₱75, not the stray ₱72", () => {
    const r = resolveRates(configs, { employeeId: "x", monthlySalary: 0 }, "2026-11-16");
    expect([r.daily.value, r.hourly.value, r.hourly.source]).toEqual([600, 75, "derived"]);
  });
});
