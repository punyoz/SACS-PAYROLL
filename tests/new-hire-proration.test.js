/**
 * New hires are paid by the day from the hire date (decision of Oct 10, 2026;
 * docs/payroll-schedule-loans-awol.md §7.6): each half pays the daily rate ×
 * paid days from the hire date, deductions on the 2nd half only. Before this
 * a hire on Oct 20 was paid the full October (₱15,000 + a full month gross).
 *
 * School settings: ₱30,000 a month, 261 working days a year (daily ₱1,379.31),
 * SSS ₱400 + Pag-IBIG ₱200, BIR monthly table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, setMissingTables, table, users } from "./helpers/fake-supabase.js";
import { hireProration, paidDaysBetween } from "@/lib/payroll/semi-monthly";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

describe("paidDaysBetween / hireProration", () => {
  it("counts Monday to Friday, holidays included", () => {
    expect(paidDaysBetween("2026-10-07", "2026-10-15")).toBe(7);   // Wed 7 → Thu 15
    expect(paidDaysBetween("2026-10-20", "2026-10-31")).toBe(9);   // Tue 20 → Sat 31
    expect(paidDaysBetween("2026-11-23", "2026-11-30")).toBe(6);   // Mon 30 Bonifacio Day counts
    expect(paidDaysBetween("2026-10-10", "2026-10-10")).toBe(0);   // a Saturday
    expect(paidDaysBetween("2026-10-10", "2026-10-10", 313)).toBe(1); // Saturdays are school days
  });

  it("pays normally when hired on or before the span's first day", () => {
    expect(hireProration({ dateHired: "2026-10-01", startKey: "2026-10-01", endKey: "2026-10-15", dailyRate: 1379.31, cap: 15000 })).toBeNull();
    expect(hireProration({ dateHired: "2025-06-01", startKey: "2026-10-01", endKey: "2026-10-31", dailyRate: 1379.31, cap: 30000 })).toBeNull();
    expect(hireProration({ dateHired: null, startKey: "2026-10-01", endKey: "2026-10-31", dailyRate: 1379.31, cap: 30000 })).toBeNull();
  });

  it("is not hired yet when the hire date is after the span", () => {
    expect(hireProration({ dateHired: "2026-10-20", startKey: "2026-10-01", endKey: "2026-10-15", dailyRate: 1379.31, cap: 15000 }))
      .toMatchObject({ not_hired: true, amount: 0 });
  });

  it("never pays more than the span's normal pay", () => {
    // Hired Fri Oct 2: 21 days × 1,379.31 = 28,965.51, under the ₱30,000 month.
    expect(hireProration({ dateHired: "2026-10-02", startKey: "2026-10-01", endKey: "2026-10-31", dailyRate: 1379.31, cap: 30000 }))
      .toMatchObject({ days: 21, amount: 28965.51, capped: false });
    // A 23-weekday month (e.g. a hire on the 2nd of a 31-day month starting on Thursday) is capped.
    expect(hireProration({ dateHired: "2026-12-02", startKey: "2026-12-01", endKey: "2026-12-31", dailyRate: 1379.31, cap: 30000 }))
      .toMatchObject({ days: 22, amount: 30000, capped: true });
  });
});

// ── Through the payroll API ────────────────────────────────────────────────

const BRANCH = "branch-a";
const OCT_1 = "October 1-15, 2026";
const OCT_16 = "October 16-31, 2026";
const BIR = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];

const rate = (rateType, value, effective = "2026-10-01") => ({
  id: `cfg-${rateType}-${effective}`, rate_type: rateType, scope: "global", scope_ref: null, value,
  effective_date: effective, created_at: `${effective}T00:00:00Z`,
});

let PATCH;
let GET;
let createSessionToken;
let SESSION_COOKIE;

const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" };

function request(body) {
  const token = createSessionToken({ ...ACCOUNTANT, email: "acct@sacs.test", session_id: "s-1" });
  return new Request("https://sacs.test/api/accountant/payroll", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify(body),
  });
}

async function generate(on, employeeId, period) {
  vi.setSystemTime(new Date(`${on}T10:00:00+08:00`));
  const response = await PATCH(request({ action: "generate", employee_id: employeeId, pay_period: period }));
  const body = await response.json();
  const entry = table("payroll_entries").find((row) => row.employee_id === employeeId && row.pay_period === period) || null;
  return { response, body, entry };
}

const person = (id, name, code, hired) => ({
  auth: { id, email: `${id}@sacs.test`, user_metadata: { role: "employee", full_name: name, employee_id: code, basic_salary: 30000, branch_id: BRANCH, position: "Teacher I" } },
  profile: { id, full_name: name, email: `${id}@sacs.test`, branch_id: BRANCH, payroll_hold: false, date_hired: hired },
});

const STAFF = [
  person("u-old", "Maria Santos", "SACS-001", "2025-06-01"),
  person("u-oct07", "Paolo Diaz", "SACS-002", "2026-10-07"),
  person("u-oct20", "Liza Cruz", "SACS-003", "2026-10-20"),
];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-new-hire";
  resetDb();
  setMissingTables([]);
  users.push(...STAFF.map((s) => s.auth));
  table("profiles").push({ id: "u-acct", branch_id: BRANCH }, ...STAFF.map((s) => s.profile));
  table("branches").push({ id: BRANCH, name: "Antipolo" });
  table("payroll_rate_configs").push(
    rate("hourly", 0, "2026-01-01"), rate("daily", 0, "2026-01-01"), rate("half_day_pct", 50, "2026-01-01"), rate("absent_pct", 100, "2026-01-01"),
    rate("late_minute_charge_pct", 0, "2026-01-01"), rate("early_bird_bonus", 0, "2026-01-01"), rate("perfect_attendance_bonus", 0, "2026-01-01"),
    ...Object.entries({
      overtime_premium_pct: 0, working_days_per_year: 261, late_days_per_absent: 0, payroll_per_half: 0,
      contribution_method: 1, contribution_half: 2, sss_fixed: 400, philhealth_fixed: 0, pagibig_fixed: 200,
      attendance_lock_day: 15, carry_after_lock: 1,
    }).map(([type, value]) => rate(type, value)),
  );
  table("payroll_tax_brackets").push(...BIR.map(([over, base, pct]) => ({
    id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
  })));

  ({ PATCH, GET } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => {
  setMissingTables(["payroll_schedule_settings"]);
  vi.useRealTimers();
});

describe("Worked example 7.6: new hires in October 2026", () => {
  it("hired before October: unchanged, ₱15,000 then ₱13,114.95", async () => {
    const first = await generate("2026-10-15", "u-old", OCT_1);
    expect(first.response.status).toBe(200);
    expect(first.entry.payroll.totals.net_pay).toBe(15000);
    const second = await generate("2026-10-30", "u-old", OCT_16);
    expect(second.response.status).toBe(200);
    expect(second.entry.payroll.monthly).toMatchObject({ monthly_gross: 30000, withholding_tax: 1285.05 });
    expect(second.entry.payroll.monthly.new_hire).toBeUndefined();
    expect(second.entry.payroll.totals.net_pay).toBe(13114.95);
  });

  it("hired Wed Oct 7: 1st half 7 days = ₱9,655.17, nothing deducted", async () => {
    const { response, entry } = await generate("2026-10-15", "u-oct07", OCT_1);
    expect(response.status).toBe(200);
    expect(entry.payroll.totals).toMatchObject({ net_pay: 9655.17, total_deductions: 0 });
    expect(entry.payroll.monthly.new_hire).toMatchObject({ hired_on: "2026-10-07", days: 7, daily_rate: 1379.31, amount: 9655.17 });
  });

  it("hired Wed Oct 7: 2nd half settles 18 days = ₱24,827.58, net ₱14,063.22", async () => {
    await generate("2026-10-15", "u-oct07", OCT_1);
    const { response, entry } = await generate("2026-10-30", "u-oct07", OCT_16);
    expect(response.status).toBe(200);
    expect(entry.payroll.monthly).toMatchObject({
      monthly_salary: 24827.58, monthly_gross: 24827.58, contributions: 600, withholding_tax: 509.19,
      monthly_net: 23718.39, first_half_paid: 9655.17, second_half_net: 14063.22,
    });
    expect(entry.payroll.monthly.new_hire).toMatchObject({ days: 18, amount: 24827.58 });
    expect(entry.payroll.totals.net_pay).toBe(14063.22);
    // 13th month counts what was earned, not the full salary.
    expect(entry.payroll.basic_earned).toBe(toCents(24827.58 - 9655.17));
  });

  it("hired Tue Oct 20: no 1st-half payslip; 2nd half 9 days = ₱12,413.79, net ₱11,813.79", async () => {
    const first = await generate("2026-10-15", "u-oct20", OCT_1);
    expect(first.response.status).toBe(422);
    expect(first.body.code).toBe("not_hired_yet");
    expect(first.body.error).toContain("Hired Oct 20, 2026");
    expect(first.entry).toBeNull();

    const second = await generate("2026-10-30", "u-oct20", OCT_16);
    expect(second.response.status).toBe(200);
    expect(second.entry.payroll.monthly).toMatchObject({
      monthly_gross: 12413.79, contributions: 600, withholding_tax: 0, first_half_paid: 0, second_half_net: 11813.79,
    });
    expect(second.entry.payroll.monthly.new_hire.text).toBe("Hired Oct 20, 2026: 9 days × 1,379.31");
    expect(second.entry.payroll.totals.net_pay).toBe(11813.79);

    // The PDF says why the pay is not the monthly salary.
    const token = createSessionToken({ ...ACCOUNTANT, email: "acct@sacs.test", session_id: "s-1" });
    const pdf = await GET(new Request(`https://sacs.test/api/accountant/payroll?format=pdf&entry_id=${second.entry.id}`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }));
    expect(pdf.status).toBe(200);
    const text = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    expect(text).toContain("Paid from hire date \\(9 days\\)"); // PDF string escapes
    expect(text).toContain("Hired Oct 20, 2026: 9 days");
  });
});

function toCents(value) {
  return Math.round(value * 100) / 100;
}

// ── A month with no earnings (decision of Oct 10, 2026; doc §5.3) ──────────

describe("A month with no earnings deducts no contributions", () => {
  const absentEveryWorkday = (employeeId, fromKey, toKey) => {
    const day = new Date(`${fromKey}T00:00:00Z`);
    const end = new Date(`${toKey}T00:00:00Z`);
    for (; day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const key = day.toISOString().slice(0, 10);
      table("attendance_logs").push({
        id: `abs-${employeeId}-${key}`, employee_id: employeeId, log_date: key, time_in: null, time_out: null,
        created_at: `${key}T00:00:00Z`, status: "Absent", late_minutes: 0, undertime_minutes: 0,
        is_half_day: false, is_early_bird: false, branch_id: BRANCH, archived_duplicate: false,
      });
    }
  };

  it("absent all of December (23 days ≥ the salary): gross ₱0, no SSS / Pag-IBIG, carry-over = the 1st half only", async () => {
    const first = await generate("2026-12-15", "u-old", "December 1-15, 2026");
    expect(first.entry.payroll.totals.net_pay).toBe(15000);
    // December's window here: Nov 30 – Dec 30 (no holidays in this test calendar).
    absentEveryWorkday("u-old", "2026-11-30", "2026-12-30");

    const { response, entry } = await generate("2026-12-31", "u-old", "December 16-31, 2026");
    expect(response.status).toBe(200);
    expect(entry.payroll.monthly).toMatchObject({
      attendance_cap_applied: true, monthly_gross: 0,
      sss: 0, philhealth: 0, pagibig: 0, contributions: 0, withholding_tax: 0,
      net_pay: 0, carry_over_out: 15000,
    });
    const lines = table("payroll_deductions").filter((l) => l.employee_id === "u-old" && ["sss", "philhealth", "pagibig"].includes(l.type));
    expect(lines).toHaveLength(0);
  });

  it("a month with any earnings still deducts them (worked example 7.1 unchanged)", async () => {
    absentEveryWorkday("u-old", "2026-10-29", "2026-10-29");
    const { entry } = await generate("2026-10-30", "u-old", OCT_16);
    expect(entry.payroll.monthly).toMatchObject({ monthly_gross: 28620.69, sss: 400, pagibig: 200, contributions: 600 });
  });
});
