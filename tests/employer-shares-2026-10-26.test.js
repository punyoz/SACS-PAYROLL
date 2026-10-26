/**
 * Withholding tax order, employee vs employer shares, the remittance report
 * and bonuses under the ₱90,000 ceiling (2026-10-26), through the real
 * payroll route for November 2026 with the settings live will have after
 * 20261026020000 / 20261026040000 (percentages from Nov 1, employer rates).
 *
 * Jane Marinel Dela Pena Benitez is a real live employee (₱18,500 a month).
 * Fe and Gio are made-up ₱30,000 employees for a month with tax.
 * Every expected figure was worked out by hand first (comments).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { employerContributions, monthlyContributions, withholdingTax } from "@/lib/payroll/statutory";
import { buildRemittance } from "@/lib/payroll/remittance";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const FIRST = "November 1-15, 2026";
const SECOND = "November 16-30, 2026";
const JANE = "330d8de8-d06d-4254-8dcb-d27771930556";
const PEOPLE = [
  { id: JANE, name: "Jane Marinel Dela Pena Benitez", code: "SACS-0003", salary: 18500 },
  { id: "u-fe", name: "Fe Taxed", code: "SACS-301", salary: 30000 },
  { id: "u-gio", name: "Gio Bonus", code: "SACS-302", salary: 30000 },
  { id: "u-ivy", name: "Ivy Exempt", code: "SACS-303", salary: 18500 },
];
const LEGAL = {
  sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000,
  philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000,
};
const EMPLOYER = { sss_er_pct: 10, sss_ec_low: 10, sss_ec_high: 30, sss_ec_threshold: 15000, philhealth_er_pct: 2.5, pagibig_er_pct: 2 };
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));

const rate = (rateType, value, effectiveDate = "2026-10-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;
const session = (user) => `${SESSION_COOKIE}=${createSessionToken({ session_id: `s-${user.user_id}`, email: `${user.user_id}@sacs.test`, ...user })}`;
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Pay Accountant" };
const request = (url, method = "GET", body, who = ACCOUNTANT) => {
  const req = new Request(`https://sacs.test${url}`, {
    method, headers: { "Content-Type": "application/json", cookie: session(who) }, body: body ? JSON.stringify(body) : undefined,
  });
  req.nextUrl = new URL(req.url);
  return req;
};
const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);
const ids = PEOPLE.map((p) => ({ employee_id: p.id }));

async function processNovember(extraRates = []) {
  table("payroll_rate_configs").push(...extraRates);
  vi.setSystemTime(new Date("2026-11-16T10:00:00+08:00"));
  expect((await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: FIRST, entries: ids }))).json()).processed).toHaveLength(PEOPLE.length);
  vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
  expect((await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: SECOND, entries: ids }))).json()).processed).toHaveLength(PEOPLE.length);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-employer-shares";
  resetDb();
  table("profiles").push({ id: "u-acct", branch_id: BRANCH, role: "accountant" }, { id: "u-hr", branch_id: null, role: "hr" });
  PEOPLE.forEach((p) => {
    users.push({ id: p.id, email: `${p.code}@sacs.test`, user_metadata: { role: "employee", full_name: p.name, employee_id: p.code, basic_salary: p.salary, branch_id: BRANCH } });
    table("profiles").push({ id: p.id, full_name: p.name, email: `${p.code}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: p.code, archived: false, basic_salary: p.salary, date_hired: "2024-06-01" });
  });
  table("payroll_rate_configs").push(
    rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("benefits_exempt_ceiling", 90000, "2018-01-01"),
    rate("contribution_method", 1), rate("contribution_method", 0, "2026-11-01"),
    rate("sss_fixed", 300, "2026-10-16"), rate("philhealth_fixed", 400, "2026-10-16"), rate("pagibig_fixed", 400, "2026-10-16"),
    ...Object.entries(LEGAL).map(([type, value]) => rate(type, value)),
    ...Object.entries(EMPLOYER).map(([type, value]) => rate(type, value, "2025-01-01")),
  );
  table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
    id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
  })));
  table("payroll_sss_msc_brackets").push(...MSC_ROWS);
  // Fe: a coaching incentive filed in November (pay for extra work: taxable).
  table("payroll_monthly_incentives").push({ id: "inc-fe", employee_id: "u-fe", item_date: "2026-11-20", kind: "incentive", description: "Coaching", amount: 1000, hours: null, archived: false, created_at: "2026-11-20T02:00:00Z" });
  // Ivy: exempt from all three (amounts of 0 set for her).
  table("payroll_contribution_amounts").push({ id: "ca-ivy", employee_id: "u-ivy", effective_date: "2026-11-01", sss: 0, philhealth: 0, pagibig: 0, created_at: "2026-10-26T00:00:00Z" });
  ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

describe("withholding tax, step by step (Jane, ₱18,500; Fe, ₱30,000)", () => {
  it("Jane: 1 gross 18,500 → 2 employee shares 1,587.50 → 3 taxable 16,912.50 → 4 tax 0", async () => {
    await processNovember();
    const m = entry(JANE, SECOND).payroll.monthly;
    // Step 1: basic 18,500 (9,250 + 9,250), no overtime or taxable allowances.
    expect(m.monthly_gross).toBe(18500);
    // Step 2: SSS 5% × 18,500 MSC = 925; PhilHealth 2.5% × 18,500 = 462.50; Pag-IBIG 2% × 10,000 = 200.
    expect([m.sss, m.philhealth, m.pagibig, m.contributions]).toEqual([925, 462.5, 200, 1587.5]);
    // Step 3: 18,500 − 1,587.50.
    expect(m.taxable_income).toBe(16912.5);
    // Step 4: monthly table, ₱16,912.50 ≤ ₱20,833 → exempt bracket. (Per cutoff on the
    // semi-monthly table it is the same: 9,250 − 793.75 = 8,456.25 ≤ 10,417 → 0.)
    expect([m.withholding_tax, m.tax_bracket]).toEqual([0, { over: 0, base: 0, rate_pct: 0 }]);
    expect(withholdingTax(8456.25)).toBe(0);
  });

  it("Fe: 1 gross 31,000 (incl. ₱1,000 taxable incentive) → 2 2,450 → 3 28,550 → 4 (28,550 − 20,833) × 15% = 1,157.55", async () => {
    await processNovember();
    const m = entry("u-fe", SECOND).payroll.monthly;
    expect(m.monthly_gross).toBe(31000);
    expect([m.sss, m.philhealth, m.pagibig, m.contributions]).toEqual([1500, 750, 200, 2450]);
    expect(m.taxable_income).toBe(28550);
    expect(m.withholding_tax).toBe(1157.55);
    expect(m.tax_bracket).toEqual({ over: 20833, base: 0, rate_pct: 15 });
    // Only the employee's shares came off: the employer's (3,000 + 30 + 750 + 200) are not in it.
    expect(m.taxable_income).toBe(m.monthly_gross - m.contributions);
  });
});

describe("employee share vs employer share", () => {
  it("Jane: EE 925 / 462.50 / 200; ER 1,850 + EC 30 / 462.50 / 200; remit 2,805 / 925 / 400; tax one figure", async () => {
    await processNovember();
    const payroll = entry(JANE, SECOND).payroll;
    expect(payroll.employer_contributions).toEqual({
      employee: { sss: 925, philhealth: 462.5, pagibig: 200 },
      employer: { sss: 1850, sss_ec: 30, philhealth: 462.5, pagibig: 200, total: 2542.5 },
      remit: { sss: 2805, philhealth: 925, pagibig: 400, total: 4130 },
      rates: { sss_er_pct: 10, philhealth_er_pct: 2.5, pagibig_er_pct: 2, sss_msc: 18500 },
    });
    // Net pay: 18,500 − 1,587.50 − 0 tax over both halves; the employer share is not in it.
    expect(entry(JANE, FIRST).payroll.totals.net_pay + payroll.totals.net_pay).toBe(16912.5);
    expect(JSON.stringify(payroll.monthly)).not.toMatch(/employer/);
    expect(JSON.stringify(payroll.totals)).not.toMatch(/employer/);
    expect(JSON.stringify(payroll)).not.toMatch(/employer_withholding|withholding_tax_er|er_tax/);
  });

  it("an employee exempt from contributions has no employer share either", async () => {
    await processNovember();
    expect(entry("u-ivy", SECOND).payroll.employer_contributions.employer).toEqual({ sss: 0, sss_ec: 0, philhealth: 0, pagibig: 0, total: 0 });
  });

  it("EC is ₱10 below a ₱15,000 salary credit and ₱30 from it", () => {
    const rates = { ...LEGAL, ...EMPLOYER };
    expect(employerContributions(14749.99, rates)).toMatchObject({ sss_msc: 14500, sss: 1450, sss_ec: 10 });
    expect(employerContributions(14750, rates)).toMatchObject({ sss_msc: 15000, sss: 1500, sss_ec: 30 });
    // Pag-IBIG: the employee pays 1% at ₱1,500 or less, the employer still 2%.
    expect(monthlyContributions(1500, rates).pagibig).toBe(15);
    expect(employerContributions(1500, rates).pagibig).toBe(30);
  });

  it("changing an employer rate changes the employer share only, never net pay", async () => {
    await processNovember([rate("sss_er_pct", 12, "2026-11-01"), rate("philhealth_er_pct", 3, "2026-11-01")]);
    const payroll = entry(JANE, SECOND).payroll;
    expect(payroll.employer_contributions.employer).toMatchObject({ sss: 2220, philhealth: 555 });
    expect(payroll.deductions).toMatchObject({ sss: 925, philhealth: 462.5, pagibig: 200, withholding_tax: 0 });
    expect(entry(JANE, FIRST).payroll.totals.net_pay + payroll.totals.net_pay).toBe(16912.5);
  });

  it("Jane's own payslip (employee API) shows her deductions and nothing of the employer's", async () => {
    await processNovember();
    // HR approved the November runs, so the payslips are visible to her.
    table("payroll_entries").filter((e) => e.employee_id === JANE).forEach((e) => {
      e.run_id = e.run_id || `run-${e.pay_period}`;
      const run = table("payroll_runs").find((r) => r.id === e.run_id);
      if (run) run.status = "approved";
      else table("payroll_runs").push({ id: e.run_id, status: "approved", branch_id: BRANCH, period_label: e.pay_period });
    });
    const { GET: mine } = await import("@/app/api/employee/payslips/route");
    const response = await mine(request("/api/employee/payslips?email=SACS-0003@sacs.test", "GET", null, { user_id: JANE, role: "employee", branch_id: BRANCH, full_name: "Jane Marinel Dela Pena Benitez", email: "SACS-0003@sacs.test" }));
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("925");
    expect(text).not.toMatch(/employer|sss_ec|"remit"|[^0-9.]1850[^0-9]|2542.5|"total_remit"/);
  });
});

describe("the remittance report", () => {
  it("totals employee + employer (+ EC) per agency, and tax once, for the Accountant and HR", async () => {
    await processNovember();
    const { GET: report } = await import("@/app/api/payroll/remittance/route");
    for (const who of [ACCOUNTANT, { user_id: "u-hr", role: "hr", branch_id: null, full_name: "HR Officer" }]) {
      const body = await (await report(request("/api/payroll/remittance?month=2026-11", "GET", null, who))).json();
      const jane = body.rows.find((r) => r.employee_id === JANE);
      expect(jane).toMatchObject({ sss_ee: 925, sss_er: 1850, sss_ec: 30, sss_total: 2805, philhealth_ee: 462.5, philhealth_er: 462.5, philhealth_total: 925, pagibig_ee: 200, pagibig_er: 200, pagibig_total: 400, withholding_tax: 0, total_remit: 4130, employer_recorded: true });
      const fe = body.rows.find((r) => r.employee_id === "u-fe");
      // SSS 1,500 + 3,000 + 30; PhilHealth 750 + 750; Pag-IBIG 200 + 200; tax 1,157.55.
      expect(fe).toMatchObject({ sss_total: 4530, philhealth_total: 1500, pagibig_total: 400, withholding_tax: 1157.55, total_remit: 7587.55 });
      expect(body.missing_employer).toBe(0);
    }
    const csv = await (await report(request("/api/payroll/remittance?month=2026-11&format=csv"))).text();
    expect(csv.split("\n")[0]).toContain('"SSS employee","SSS employer","SSS EC","SSS remit"');
  });

  it("Employee, Admin and Super Admin are refused", async () => {
    const { GET: report } = await import("@/app/api/payroll/remittance/route");
    const { proxy } = await import("@/proxy");
    for (const who of [
      { user_id: JANE, role: "employee", branch_id: BRANCH }, { user_id: "u-adm", role: "admin", branch_id: BRANCH }, { user_id: "u-sa", role: "super_admin", branch_id: null },
    ]) {
      expect((await report(request("/api/payroll/remittance?month=2026-11", "GET", null, who))).status, who.role).toBe(403);
      expect((await proxy(request("/api/payroll/remittance?month=2026-11", "GET", null, who))).status, `proxy ${who.role}`).toBe(403);
    }
  });

  it("flags a payslip processed before employer shares were recorded instead of guessing", () => {
    const old = { employee_id: "x", employee_name: "Old Slip", status: "paid", pay_period: "October 16-31, 2026", payroll: { deductions: { sss: 300, philhealth: 400, pagibig: 400, withholding_tax: 0 } } };
    const { rows, missing_employer } = buildRemittance([old]);
    expect(missing_employer).toBe(1);
    expect(rows[0]).toMatchObject({ sss_ee: 300, sss_er: 0, employer_recorded: false });
  });
});

describe("bonuses under the ₱90,000 ceiling", () => {
  it("Gio: ₱89,800 of benefits already paid, ₱500 perfect attendance bonus → ₱200 exempt, ₱300 taxed", async () => {
    table("payroll_exempt_benefits_paid").push({ employee_id: "u-gio", tax_year: 2026, kind: "thirteenth_month", amount: 89800, paid_on: "2026-06-30" });
    table("attendance_logs").push({
      id: "g1", employee_id: "u-gio", branch_id: BRANCH, log_date: "2026-11-17", time_in: "2026-11-17T00:00:00Z", time_out: "2026-11-17T09:00:00Z",
      created_at: "2026-11-17T00:00:00Z", status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false, arrival_offset_minutes: 0,
    });
    await processNovember([rate("perfect_attendance_bonus", 500, "2026-11-01")]);
    const m = entry("u-gio", SECOND).payroll.monthly;
    expect(m.bonuses).toEqual({ amount: 500, exempt: 200, taxable: 300, ceiling: 90000, benefits_ytd: 89800 });
    // 30,000 + 500 − 2,450 − 200 exempt = 27,850 → (27,850 − 20,833) × 15% = 1,052.55.
    expect(m.monthly_gross).toBe(30500);
    expect(m.taxable_income).toBe(27850);
    expect(m.withholding_tax).toBe(1052.55);
  });
});
