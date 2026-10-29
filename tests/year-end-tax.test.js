/**
 * Year-end tax annualization (2026-10-29): the annual computation from the
 * BIR annual table, the adjustment on the December 16-31 payslip through the
 * real payroll route, the 2316 and the alphalist with it, and who may use it
 * (the Accountant only: HR, Admin, Super Admin and employees are refused).
 *
 * Three ₱30,000-a-month employees, every figure worked out by hand first:
 *   Ana   no absences, no adjustments all year
 *   Ben   absences in April and November, partly waived by Tenure Pay
 *         Protection, absences in September fully waived by it, incentives in
 *         June and December, a ₱30,000 13th month
 *   Cara  January-September paid before the legal tax rules (no tax withheld)
 * Jan-Nov are Final, HR-approved payslips (fixtures in the engine's shape);
 * December is processed by the real route.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";
import { annualTaxDue, compute2316, payslipFigures } from "@/lib/payroll/bir-2316";
import {
  annualizationFigures, applyYearEndTax, secondCutoffLabel, yearEndAdjustment, yearEndCutoffLine, yearEndTargetAllowed, yearEndTargetOptions,
} from "@/lib/payroll/year-end-tax";

const ANA_UUID = "0a0a0a0a-0000-4000-8000-000000000401";
const BEN_UUID = "0b0b0b0b-0000-4000-8000-000000000402";
const CARA_UUID = "0c0c0c0c-0000-4000-8000-000000000403";
const DAN_UUID = "0d0d0d0d-0000-4000-8000-000000000501";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const MONTHLY = [
  { over: 0, base: 0, rate: 0 },
  { over: 20833, base: 0, rate: 0.15 },
  { over: 33333, base: 1875, rate: 0.2 },
  { over: 66667, base: 8541.8, rate: 0.25 },
  { over: 166667, base: 33541.8, rate: 0.3 },
  { over: 666667, base: 183541.8, rate: 0.35 },
];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const firstLabel = (m) => `${MONTH_NAMES[m - 1]} 1-15, 2026`;
const BRANCH = "branch-main";
const OTHER = "branch-other";
const SSS = 1500;
const PH = 750;
const PI = 200;
// ₱30,000 × 12 ÷ 261 working days.
const DAILY = 1379.31;

/** A Final, approved payslip as the engine stores it. */
const paid = (employee, label, { basic, contributions = false, wht = 0, incentive = 0, waived = null }) => ({
  id: crypto.randomUUID(),
  employee_id: employee,
  employee_name: employee,
  pay_period: label,
  status: "paid",
  run_id: "run-ok",
  branch_id: BRANCH,
  payroll: {
    basic_salary: 15000,
    basic_earned: basic,
    deductions: { sss: contributions ? SSS : 0, philhealth: contributions ? PH : 0, pagibig: contributions ? PI : 0, withholding_tax: wht },
    totals: { gross_pay: 15000, other_incentive: incentive, overtime_pay: 0, holiday_pay: 0, subsidy_pay: 0, net_pay: basic + incentive - wht - (contributions ? SSS + PH + PI : 0) },
    ...(waived ? { audit: { attendance: { tenure_protection: waived } } } : {}),
  },
});

/** Jan-Nov of one employee: month → { absent (₱ deducted), wht, incentive, waived }. */
function yearOf(employee, months) {
  const rows = [];
  for (let m = 1; m <= 11; m += 1) {
    const x = months[m] || {};
    rows.push(paid(employee, firstLabel(m), { basic: 15000 }));
    rows.push(paid(employee, secondCutoffLabel(2026, m), {
      basic: 15000 - (x.absent || 0), contributions: true, wht: x.wht ?? 1007.55, incentive: x.incentive || 0, waived: x.waived || null,
    }));
  }
  return rows;
}

const ANA = yearOf(ANA_UUID, {});
const BEN = yearOf(BEN_UUID, {
  // 3 absences, 1 waived by Tenure Pay Protection: 2 × 1,379.31 = 2,758.62.
  // Taxable 30,000 − 2,758.62 − 2,450 = 24,791.38 → (24,791.38 − 20,833) × 15% = 593.76.
  4: { absent: 2758.62, wht: 593.76, waived: [{ log_date: "2026-04-20", type: "absent", amount: DAILY }] },
  // Incentive 5,000: taxable 32,550 → (32,550 − 20,833) × 15% = 1,757.55.
  6: { incentive: 5000, wht: 1757.55 },
  // 5 absences, all waived: nothing deducted.
  9: { waived: [1, 2, 3, 4, 5].map((d) => ({ log_date: `2026-09-0${d}`, type: "absent", amount: DAILY })) },
  // 10 absences, 4 waived: 6 × 1,379.31 = 8,275.86. Taxable 19,274.14 ≤ 20,833 → 0.
  11: { absent: 8275.86, wht: 0, waived: [1, 2, 3, 4].map((d) => ({ log_date: `2026-11-0${d}`, type: "absent", amount: DAILY })) },
});
// Before the legal rules there was no default tax.
const CARA = yearOf(CARA_UUID, Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => [m, { wht: 0 }])));

const figuresOf = (entries) => entries.map((e) => ({ figures: payslipFigures(e), month: Number(/^(\w+)/.exec(e.pay_period) && MONTH_NAMES.indexOf(e.pay_period.split(" ")[0]) + 1) }));

describe("the annual computation, by hand", () => {
  it("uses the BIR annual table (₱250,000 / 400,000 / 800,000 ...)", () => {
    expect(annualTaxDue(330600, MONTHLY)).toBe(12090); // (330,600 − 250,000) × 15%
    expect(annualTaxDue(326565.52, MONTHLY)).toBe(11484.83); // 76,565.52 × 15% = 11,484.828
    expect(annualTaxDue(453600, MONTHLY)).toBe(33220); // 22,500 + (453,600 − 400,000) × 20%
  });

  it("Ana, a clean year: 12 × 27,550 = 330,600 taxable, due 12,090.00, withheld 12 × 1,007.55 = 12,090.60 → refund 0.60", () => {
    const december = [paid(ANA_UUID, "December 1-15, 2026", { basic: 15000 }), paid(ANA_UUID, "December 16-31, 2026", { basic: 15000, contributions: true, wht: 1007.55 })];
    const form = compute2316({ year: 2026, payslips: figuresOf([...ANA, ...december]), taxTable: MONTHLY });
    expect(form.boxes[36]).toBe(29400);
    expect(form.boxes[52]).toBe(330600);
    expect(form.boxes[24]).toBe(12090);
    expect(form.boxes["25A"]).toBe(12090.6);
    expect(form.difference).toBe(-0.6);
    expect(annualizationFigures(form)).toMatchObject({ tax_due: 12090, tax_withheld: 12090.6, adjustments_settled: 0, balance: -0.6 });
  });

  it("Ben, absences / Tenure Pay Protection / incentives: taxable 326,565.52, due 11,484.83, withheld 11,719.26 → refund 234.43", () => {
    const december = [
      paid(BEN_UUID, "December 1-15, 2026", { basic: 15000 }),
      // Incentive 2,000: taxable 29,550 → (29,550 − 20,833) × 15% = 1,307.55.
      paid(BEN_UUID, "December 16-31, 2026", { basic: 15000, contributions: true, wht: 1307.55, incentive: 2000 }),
    ];
    const form = compute2316({
      year: 2026, payslips: figuresOf([...BEN, ...december]), taxTable: MONTHLY, ceiling: 90000,
      benefits: [{ kind: "thirteenth_month", amount: 30000 }],
    });
    // Basic 360,000 − 2,758.62 − 8,275.86 = 348,965.52 (September's waived days cost nothing).
    expect(form.basic_earned).toBe(348965.52);
    // Non-taxable: 13th month 30,000 (under the ceiling) + contributions 29,400.
    expect([form.boxes[34], form.boxes[36], form.boxes[38]]).toEqual([30000, 29400, 59400]);
    // Taxable: 348,965.52 − 29,400 + incentives 7,000.
    expect([form.boxes[39], form.boxes["51B"], form.boxes[52]]).toEqual([319565.52, 7000, 326565.52]);
    expect(form.boxes[19]).toBe(385965.52);
    // 8 × 1,007.55 + 593.76 + 1,757.55 + 0 + 1,307.55.
    expect(form.boxes["25A"]).toBe(11719.26);
    expect(form.boxes[24]).toBe(11484.83);
    expect(form.difference).toBe(-234.43);
  });

  it("settled adjustments are tax withheld as adjusted (box 25A / 26): the balance goes to zero", () => {
    const form = compute2316({ year: 2026, payslips: figuresOf(ANA), taxTable: MONTHLY, adjustments: [{ amount: 100 }, { amount: -40 }] });
    expect(form.withheld_regular).toBe(11083.05);
    expect(form.year_end_adjustment).toBe(60);
    expect(form.boxes["25A"]).toBe(11143.05);
    expect(form.boxes[26]).toBe(11143.05);
  });
});

describe("the adjustment on the payslip", () => {
  const prior = { payslips: figuresOf(CARA), benefits: [], adjustments: [] };
  const decFirst = { figures: payslipFigures(paid(CARA_UUID, "December 1-15, 2026", { basic: 15000 })), month: 12 };

  it("collects what is due, never more than the payslip can pay, and says what is left", () => {
    // Cara with December: due 12,090; withheld Oct + Nov 2,015.10 + 1,007.55 on this payslip = 3,022.65 → 9,067.35.
    const current = { figures: payslipFigures(paid(CARA_UUID, "December 16-31, 2026", { basic: 15000, contributions: true, wht: 1007.55 })), month: 12 };
    const full = yearEndAdjustment({ year: 2026, prior: { ...prior, payslips: [...prior.payslips, decFirst] }, current, taxTable: MONTHLY, ceiling: 90000, available: 11542.45 });
    expect(full).toMatchObject({ kind: "collect", amount: 9067.35, shortfall: 0, tax_due: 12090, withheld: 3022.65 });
    const short = yearEndAdjustment({ year: 2026, prior: { ...prior, payslips: [...prior.payslips, decFirst] }, current, taxTable: MONTHLY, ceiling: 90000, available: 5000 });
    expect(short).toMatchObject({ kind: "collect", amount: 5000, shortfall: 4067.35 });
  });

  it("is its own line: withholding tax untouched, net and total deductions moved, carry-over kept right", () => {
    const payroll = {
      deductions: { withholding_tax: 1007.55 },
      totals: { total_deductions: 18457.55, net_pay: 11542.45 },
      monthly: { second_half_net: 11542.45, net_pay: 11542.45, carry_over_out: 0 },
      sheet: { net_pay: 11542.45 },
      audit: { lines: { deductions: [], incentives: [] } },
    };
    applyYearEndTax(payroll, { kind: "refund", amount: 234.43, shortfall: 0, tax_due: 11484.83, taxable: 326565.52, withheld: 11719.26, settled_before: 0 }, { annualizationId: "a-1", taxYear: 2026 });
    expect(payroll.deductions.withholding_tax).toBe(1007.55);
    expect(payroll.totals.net_pay).toBe(11776.88);
    // A refund raises net pay; the total deductions stay what was deducted.
    expect(payroll.totals.total_deductions).toBe(18457.55);
    expect(payroll.sheet.net_pay).toBe(11776.88);
    expect(payroll.year_end_tax).toMatchObject({ annualization_id: "a-1", tax_year: 2026, kind: "refund", amount: 234.43, signed: -234.43 });
    expect(payroll.year_end_tax.label).toBe("Year-end tax adjustment 2026 (refund)");
    expect(payroll.audit.lines.incentives).toEqual([expect.objectContaining({ type: "year_end_tax_refund", amount: 234.43 })]);
    expect(yearEndCutoffLine(payroll.year_end_tax)).toMatchObject({ amount: 234.43, credit: true });

    // A collection on a 2nd half already short (net −100 carried over): nothing collected, the balance stays.
    const short = { totals: { total_deductions: 0, net_pay: 0 }, monthly: { second_half_net: -100, carry_over_out: 100 }, audit: { lines: { deductions: [], incentives: [] } } };
    applyYearEndTax(short, yearEndAdjustment({ year: 2026, prior, current: null, taxTable: MONTHLY, ceiling: 90000, available: -100 }), { taxYear: 2026 });
    expect(short.year_end_tax).toMatchObject({ kind: "collect", amount: 0 });
    expect(short.year_end_tax.shortfall).toBeGreaterThan(0);
    expect(short.monthly.carry_over_out).toBe(100);
    expect(short.audit.lines.deductions).toEqual([]);
  });

  it("goes on a 2nd cutoff of the tax year or January 16-31 of the next, December first", () => {
    expect(yearEndTargetAllowed("December 16-31, 2026", 2026)).toBe(true);
    expect(yearEndTargetAllowed("January 16-31, 2027", 2026)).toBe(true);
    expect(yearEndTargetAllowed("February 16-28, 2027", 2026)).toBe(false);
    expect(yearEndTargetAllowed("December 1-15, 2026", 2026)).toBe(false);
    expect(yearEndTargetOptions(2026, "2026-10-29")).toEqual(["December 16-31, 2026", "October 16-31, 2026", "November 16-30, 2026", "January 16-31, 2027"]);
  });
});

/* ── Through the real routes ── */

const rate = (rateType, value, effectiveDate = "2026-10-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});
const LEGAL = { sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000, philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000 };
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
const PEOPLE = [
  { id: ANA_UUID, name: "Ana Clean", code: "SACS-401", position: "Teacher I" },
  { id: BEN_UUID, name: "Ben Mixed", code: "SACS-402", position: "Teacher II" },
  { id: CARA_UUID, name: "Cara Untaxed", code: "SACS-403", position: "Registrar" },
];
const DEC1 = "December 1-15, 2026";
const DEC2 = "December 16-31, 2026";

const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Pay Accountant" };
const OTHER_ACCOUNTANT = { user_id: "u-acct2", role: "accountant", branch_id: OTHER, full_name: "Far Accountant" };
const HR = { user_id: "u-hr", role: "hr", branch_id: null, full_name: "HR Officer" };
const SUPER = { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "System Admin" };
const ADMIN = { user_id: "u-adm", role: "admin", branch_id: BRANCH, full_name: "Branch Admin" };
const EMPLOYEE = { user_id: ANA_UUID, role: "employee", branch_id: BRANCH, full_name: "Ana Clean" };

let payrollRoute;
let createSessionToken;
let SESSION_COOKIE;
const session = (user) => `${SESSION_COOKIE}=${createSessionToken({ session_id: "s-1", email: `${user.user_id}@sacs.test`, ...user })}`;
const request = (url, method = "GET", body, who = ACCOUNTANT) => {
  const req = new Request(`https://sacs.test${url}`, {
    method, headers: { "Content-Type": "application/json", cookie: session(who) }, body: body ? JSON.stringify(body) : undefined,
  });
  req.nextUrl = new URL(req.url);
  return req;
};
const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);
const yearEnd = () => import("@/app/api/payroll/year-end-tax/route");
const birForms = () => import("@/app/api/payroll/bir-forms/route");

async function batch(label, at) {
  vi.setSystemTime(new Date(at));
  const body = await (await payrollRoute.POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: label, entries: PEOPLE.map((p) => ({ employee_id: p.id })) }))).json();
  expect(body.processed, JSON.stringify(body.failed || body.error)).toHaveLength(PEOPLE.length);
}

/** HR approved these payslips' run. */
function approve(label) {
  table("payroll_entries").filter((e) => e.pay_period === label).forEach((e) => { e.run_id = "run-ok"; });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-year-end-tax";
  resetDb();
  table("branches").push({ id: BRANCH, name: "Pasig" }, { id: OTHER, name: "Antipolo" });
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH, role: "accountant", full_name: "Pay Accountant", archived: false },
    { id: "u-acct2", branch_id: OTHER, role: "accountant", full_name: "Far Accountant", archived: false },
    { id: "u-hr", branch_id: null, role: "hr", archived: false },
    { id: "u-sa", branch_id: null, role: "super_admin", archived: false },
    { id: "u-adm", branch_id: BRANCH, role: "admin", archived: false },
  );
  PEOPLE.forEach((p) => {
    users.push({ id: p.id, email: `${p.code}@sacs.test`, app_metadata: { session_id: "s-1" }, user_metadata: { role: "employee", full_name: p.name, employee_id: p.code, basic_salary: 30000, branch_id: BRANCH, date_of_birth: "1990-01-01" } });
    const [first, last] = p.name.split(" ");
    table("profiles").push({ id: p.id, full_name: p.name, first_name: first, last_name: last, email: `${p.code}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: p.code, position: p.position, archived: false, basic_salary: 30000, date_hired: "2024-06-01", employee_status: "Active" });
  });
  users.push(...[ACCOUNTANT, HR, SUPER, ADMIN].map((u) => ({ id: u.user_id, email: `${u.user_id}@sacs.test`, app_metadata: { session_id: "s-1" }, user_metadata: { role: u.role } })));
  table("payroll_rate_configs").push(
    rate("daily", DAILY), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("benefits_exempt_ceiling", 90000, "2018-01-01"), rate("contribution_method", 0),
    ...Object.entries(LEGAL).map(([type, value]) => rate(type, value)),
  );
  table("payroll_tax_brackets").push(...MONTHLY.map((r) => ({
    id: `bir-${r.over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: r.over, base_tax: r.base, rate_pct: r.rate * 100, created_at: "2023-01-01T00:00:00Z",
  })));
  table("payroll_sss_msc_brackets").push(...MSC_ROWS);
  table("payroll_runs").push({ id: "run-ok", status: "approved", branch_id: BRANCH });
  table("payroll_entries").push(...structuredClone([...ANA, ...BEN, ...CARA]));
  // Ben: an incentive filed for December, and his 13th month.
  table("payroll_monthly_incentives").push({ id: "inc-ben", employee_id: BEN_UUID, item_date: "2026-12-10", kind: "incentive", description: "Recognition", amount: 2000, hours: null, archived: false, approval_status: "approved", decided_at: "2026-12-10T02:00:00Z", created_at: "2026-12-10T01:00:00Z" });
  table("payroll_exempt_benefits_paid").push({ employee_id: BEN_UUID, tax_year: 2026, kind: "thirteenth_month", amount: 30000, paid_on: "2026-12-10" });
  table("system_config").push({ section: "general", key: "bir_employer_name", value: "SACS Inc." }, { section: "general", key: "bir_employer_tin", value: "111222333" });
  rpc.results.get_profiles_pii = { data: PEOPLE.map((p, i) => ({ id: p.id, tin_number: `12345678${i}` })), error: null };
  // The two database functions of 20261029010000, as they store.
  rpc.results.payroll_tax_annualization_save = ({ p_actor, p_year, p_rows }) => {
    p_rows.forEach((r) => {
      const rows = table("payroll_tax_annualizations");
      const existing = rows.find((x) => x.tax_year === p_year && x.employee_id === r.employee_id);
      if (existing) Object.assign(existing, r, { run_count: existing.run_count + 1, computed_by: p_actor });
      else rows.push({ id: crypto.randomUUID(), tax_year: p_year, branch_id: BRANCH, status: "computed", target_period: null, run_count: 1, history: [], computed_by: p_actor, ...r });
    });
    return { data: p_rows.length, error: null };
  };
  rpc.results.payroll_tax_annualization_schedule = ({ p_id, p_period }) => {
    const row = table("payroll_tax_annualizations").find((x) => x.id === p_id);
    Object.assign(row, { status: p_period ? "scheduled" : "computed", target_period: p_period });
    return { data: row, error: null };
  };
  // payroll_bir_read_scope / payroll_bir_export_save, with the SQL's rules.
  const profileOf = (id) => table("profiles").find((x) => x.id === id);
  rpc.results.payroll_bir_read_scope = ({ p_actor }) => {
    const actor = profileOf(p_actor);
    if (actor?.role === "accountant") return { data: [{ role: "accountant", branch_id: actor.branch_id, read_only: false }], error: null };
    if (actor?.role === "super_admin") return { data: [{ role: "super_admin", branch_id: null, read_only: true }], error: null };
    return { data: null, error: { message: "forbidden: only the Accountant and (read-only) the Super Admin see the year-end tax records." } };
  };
  rpc.results.payroll_bir_export_save = ({ p_actor, p_kind, p_year, p_format, p_employee, p_rows, p_employer, p_totals }) => {
    const actor = profileOf(p_actor);
    if (actor?.role !== "accountant") return { data: null, error: { message: "forbidden: only the Accountant runs the year-end tax annualization." } };
    if (p_kind === "bir_2316" && p_rows.some((r) => profileOf(r.employee_id)?.branch_id !== actor.branch_id)) {
      return { data: null, error: { message: "forbidden: a 2316 covers only employees of your branch." } };
    }
    const id = crypto.randomUUID();
    table("payroll_bir_exports").push({
      id, kind: p_kind, tax_year: p_year, format: p_format, scope: p_kind === "alphalist" ? "school" : "branch", branch_id: actor.branch_id,
      employee_id: p_employee, employee_count: p_rows.length, employer: p_employer, rows: p_rows, totals: p_totals,
      generated_by: actor.id, generated_by_name: actor.full_name, generated_at: new Date().toISOString(),
    });
    return { data: id, error: null };
  };
  // An employee of the other branch, with two approved 2026 payslips.
  table("profiles").push({ id: DAN_UUID, full_name: "Dan North", first_name: "Dan", last_name: "North", branch_id: OTHER, role: "employee", employee_id: "SACS-501", position: "Guard", archived: false, basic_salary: 20000, date_hired: "2023-01-01", employee_status: "Active" });
  table("payroll_entries").push(
    { ...paid(DAN_UUID, "March 1-15, 2026", { basic: 10000 }), branch_id: OTHER },
    { ...paid(DAN_UUID, "March 16-31, 2026", { basic: 10000, contributions: true }), branch_id: OTHER },
  );
  payrollRoute = await import("@/app/api/accountant/payroll/route");
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

async function runAnnualization(at) {
  vi.setSystemTime(new Date(at));
  const response = await (await yearEnd()).POST(request("/api/payroll/year-end-tax", "POST", { action: "run", year: 2026 }));
  expect(response.status).toBe(200);
  return response.json();
}

async function scheduleAll(body) {
  for (const row of body.rows) {
    const response = await (await yearEnd()).POST(request("/api/payroll/year-end-tax", "POST", { action: "schedule", id: row.id, period: DEC2 }));
    expect(response.status).toBe(200);
  }
}

describe("December 2026 through the real payroll route", () => {
  it("stores the annualization as its own record, re-runnable, and the December 16-31 payslip carries the adjustment", async () => {
    const before = structuredClone(table("payroll_entries"));
    await batch(DEC1, "2026-12-16T10:00:00+08:00");

    // Mid-December: Jan-Nov only (December 1-15 is not approved yet).
    const first = await runAnnualization("2026-12-20T10:00:00+08:00");
    expect(first.saved).toBe(3);
    const rec = (body, id) => body.rows.find((r) => r.employee_id === id);
    // Ana so far: 11 × 27,550 = 303,050 → due 7,957.50; withheld 11,083.05 → 3,125.55 over.
    expect(rec(first, ANA_UUID)).toMatchObject({ taxable_compensation: 303050, tax_due: 7957.5, tax_withheld: 11083.05, balance: -3125.55, settlement: "refund" });
    expect(table("payroll_tax_annualizations")).toHaveLength(3);
    await scheduleAll(first);
    expect(rec(await (await (await yearEnd()).GET(request("/api/payroll/year-end-tax?year=2026"))).json(), ANA_UUID)).toMatchObject({ status: "scheduled", target_period: DEC2, schedule_state: "waiting" });

    // The Process page preview already shows it.
    vi.setSystemTime(new Date("2027-01-02T10:00:00+08:00"));
    const preview = await (await payrollRoute.GET(request(`/api/accountant/payroll?period=${encodeURIComponent(DEC2)}`))).json();
    expect(preview.attendance_rows.find((r) => r.employee_id === BEN_UUID).defaults.year_end_tax).toBe(-234.43);

    await batch(DEC2, "2027-01-02T10:00:00+08:00");
    const ana = entry(ANA_UUID, DEC2).payroll;
    const ben = entry(BEN_UUID, DEC2).payroll;
    const cara = entry(CARA_UUID, DEC2).payroll;

    // The regular withholding tax of December is the monthly table's, untouched.
    expect(ana.deductions.withholding_tax).toBe(1007.55);
    expect(ben.deductions.withholding_tax).toBe(1307.55);
    expect(cara.deductions.withholding_tax).toBe(1007.55);
    expect(entry(ANA_UUID, DEC2).withholding_tax ?? ana.deductions.withholding_tax).toBe(1007.55);

    // Ana: refund 0.60. Ben: refund 234.43. Cara: due 12,090 − withheld (3 × 1,007.55) → collect 9,067.35.
    expect(ana.year_end_tax).toMatchObject({ kind: "refund", amount: 0.6, signed: -0.6, tax_due: 12090 });
    expect(ben.year_end_tax).toMatchObject({ kind: "refund", amount: 234.43, signed: -234.43, tax_due: 11484.83, taxable: 326565.52, withheld_before: 11719.26 });
    expect(cara.year_end_tax).toMatchObject({ kind: "collect", amount: 9067.35, signed: 9067.35, shortfall: 0, tax_due: 12090 });

    // Net pay: 30,000 − 2,450 − 1,007.55 − 15,000 (1st half) = 11,542.45, then the adjustment.
    expect(ana.totals.net_pay).toBe(11543.05);
    expect(cara.totals.net_pay).toBe(2475.1);
    // Ben: 32,000 − 2,450 − 1,307.55 − 15,000 = 13,242.45 + 234.43.
    expect(ben.totals.net_pay).toBe(13476.88);

    // Its own labelled line on the payslip, and its own line row.
    expect(ben.monthly.cutoff.deductions.find((l) => l.label.startsWith("Year-end tax adjustment"))).toMatchObject({ label: "Year-end tax adjustment 2026 (refund)", amount: 234.43, credit: true });
    expect(cara.monthly.cutoff.deductions.find((l) => l.label.startsWith("Year-end tax adjustment"))).toMatchObject({ amount: 9067.35 });
    expect(cara.monthly.cutoff.deductions.find((l) => l.label.startsWith("Withholding tax"))).toMatchObject({ amount: 1007.55 });
    const ofCara = cara.monthly.cutoff;
    expect(ofCara.gross_pay - ofCara.total_deductions).toBeCloseTo(cara.totals.net_pay, 2);
    expect(cara.audit.lines.deductions.filter((l) => l.type === "year_end_tax")).toHaveLength(1);
    expect(ben.audit.lines.incentives.filter((l) => l.type === "year_end_tax_refund")).toHaveLength(1);

    // No earlier payslip was changed.
    const after = table("payroll_entries").filter((e) => before.some((b) => b.id === e.id));
    expect(after).toEqual(before);

    // HR approves December; the annualization run again settles at zero.
    approve(DEC1);
    approve(DEC2);
    const again = await runAnnualization("2027-01-05T10:00:00+08:00");
    expect(rec(again, ANA_UUID)).toMatchObject({ tax_due: 12090, tax_withheld: 12090.6, adjustments_settled: -0.6, balance: 0, settlement: "none", schedule_state: "final" });
    expect(rec(again, BEN_UUID)).toMatchObject({ tax_due: 11484.83, tax_withheld: 11719.26, adjustments_settled: -234.43, balance: 0 });
    expect(rec(again, CARA_UUID)).toMatchObject({ tax_due: 12090, tax_withheld: 3022.65, adjustments_settled: 9067.35, balance: 0 });
    expect(table("payroll_tax_annualizations")).toHaveLength(3);
    expect(table("payroll_tax_annualizations").every((r) => r.run_count === 2)).toBe(true);

    // The 2316 and the alphalist carry it: tax withheld as adjusted = tax due.
    const forms = await (await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026"))).json();
    const cara2316 = forms.rows.find((r) => r.employee_id === CARA_UUID);
    expect(cara2316).toMatchObject({ gross: 360000, non_taxable: 29400, taxable: 330600, tax_due: 12090, tax_withheld: 12090, year_end_adjustment: 9067.35, settlement: "none" });
    const ben2316 = forms.rows.find((r) => r.employee_id === BEN_UUID);
    expect(ben2316).toMatchObject({ gross: 385965.52, non_taxable: 59400, taxable: 326565.52, tax_due: 11484.83, tax_withheld: 11484.83, year_end_adjustment: -234.43 });

    const csv = await (await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026&format=csv"))).text();
    const cells = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, "\"")).slice(0, -1);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    const header = cells(lines[0]);
    const col = (name) => header.indexOf(name);
    const benRow = cells(lines.find((l) => l.includes(",Mixed,Ben,")));
    expect(header.length).toBe(benRow.length);
    expect(Number(benRow[col("Gross compensation income")])).toBe(385965.52);
    expect(Number(benRow[col("Total taxable compensation income")])).toBe(326565.52);
    expect(Number(benRow[col("Tax withheld January - November")])).toBe(10411.71);
    expect(Number(benRow[col("Tax withheld December")])).toBe(1307.55);
    expect(Number(benRow[col("Year-end tax adjustment (+ collected / - refunded)")])).toBe(-234.43);
    expect(Number(benRow[col("Total tax withheld")])).toBe(11484.83);
    // = the sum of his payroll records for the year (regular withholding + the adjustment line).
    const benYear = table("payroll_entries").filter((e) => e.employee_id === BEN_UUID && e.pay_period.endsWith("2026"));
    const withheld = benYear.reduce((s, e) => s + (e.payroll.deductions?.withholding_tax || 0) + (e.payroll.year_end_tax?.signed || 0), 0);
    expect(Math.round(withheld * 100) / 100).toBe(11484.83);

    // One employee's 2316: every field from the data.
    const pdf = await (await birForms()).GET(request(`/api/payroll/bir-forms?year=2026&format=pdf&employee_id=${BEN_UUID}`));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("Content-Disposition")).toContain("BIR-2316-2026-SACS-402.pdf");
    const text = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    expect(text).toContain("/Count 1");
    for (const field of [
      "(Mixed, Ben)", "(Teacher II)", "(Pasig)", "(123-456-781-00000)", "(SACS-402)", "(SACS Inc.)", "(111-222-333-00000)",
      "(01/01/2026 to 12/31/2026)", "(385,965.52)", "(59,400.00)", "(326,565.52)", "(11,484.83)", "(30,000.00)", "(7,000.00)", "(-234.43)",
    ]) expect(text, field).toContain(field);
    // PDF strings escape parentheses.
    expect(text).toContain("of which year-end tax adjustment \\(refunded\\)");
    expect(text).not.toContain("Ana Clean");
    // Another branch's employee, or nobody, is not reachable by id.
    expect((await (await birForms()).GET(request(`/api/payroll/bir-forms?year=2026&format=pdf&employee_id=${crypto.randomUUID()}`))).status).toBe(404);
  });

  it("re-running before December changes only the record, never a payslip, and the schedule is kept", async () => {
    const first = await runAnnualization("2026-12-20T10:00:00+08:00");
    await scheduleAll(first);
    const snapshot = structuredClone(table("payroll_entries"));
    // A Jan-Nov payslip corrected before year-end close (e.g. Ana's June tax re-stated by a correction) → re-run.
    table("payroll_entries").find((e) => e.employee_id === ANA_UUID && e.pay_period === "June 16-30, 2026").payroll.deductions.withholding_tax = 0;
    const second = await runAnnualization("2026-12-21T10:00:00+08:00");
    const ana = second.rows.find((r) => r.employee_id === ANA_UUID);
    expect(ana).toMatchObject({ tax_withheld: 10075.5, status: "scheduled", target_period: DEC2 });
    expect(table("payroll_entries").filter((e) => e.employee_id !== ANA_UUID)).toEqual(snapshot.filter((e) => e.employee_id !== ANA_UUID));
  });
});

describe("who may use it (decisions 2026-10-29)", () => {
  const proxyRequest = (path, method, body, who) => new NextRequest(`https://sacs.test${path}`, { method, headers: { cookie: session(who), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const GENERATE = [
    ["/api/payroll/year-end-tax", "POST", { action: "run", year: 2026 }],
    ["/api/payroll/year-end-tax", "POST", { action: "schedule", id: "0e0e0e0e-0000-4000-8000-000000000000", period: DEC2 }],
    ["/api/payroll/year-end-tax", "POST", { action: "unschedule", id: "0e0e0e0e-0000-4000-8000-000000000000" }],
    ["/api/payroll/bir-forms?year=2026", "GET"],
    ["/api/payroll/bir-forms?year=2026&format=pdf", "GET"],
    ["/api/payroll/bir-forms?year=2026&format=csv", "GET"],
    ["/api/payroll/bir-forms?year=2026&format=xlsx", "GET"],
  ];
  const READ = [["/api/payroll/year-end-tax?year=2026", "GET"], ["/api/payroll/bir-exports?year=2026", "GET"]];
  const moduleFor = async (path) => (path.startsWith("/api/payroll/year-end-tax") ? yearEnd()
    : path.startsWith("/api/payroll/bir-exports") ? import("@/app/api/payroll/bir-exports/route") : birForms());

  it("refuses HR, Admin and employees everything: routes and proxy", async () => {
    const { proxy } = await import("@/proxy");
    const { GET: own } = await import("@/app/api/employee/bir-2316/route");
    for (const who of [HR, ADMIN, EMPLOYEE]) {
      for (const [path, method, body] of [...GENERATE, ...READ]) {
        const response = await (await moduleFor(path))[method](request(path, method, body, who));
        expect(response.status, `${who.role} ${method} ${path}`).toBe(403);
        expect((await proxy(proxyRequest(path, method, body, who))).status, `proxy ${who.role} ${method} ${path}`).not.toBe(200);
      }
    }
    expect(rpc.calls.filter((c) => /^payroll_(tax_annualization|bir_export)/.test(c.fn))).toEqual([]);
    expect(table("payroll_tax_annualizations")).toEqual([]);
    // Kept: the employee's own finished-year 2316.
    vi.setSystemTime(new Date("2027-02-01T10:00:00+08:00"));
    expect((await own(request("/api/employee/bir-2316", "GET", null, EMPLOYEE))).status).toBe(200);
  });

  it("Super Admin: reads every branch's records and generated files, read-only; every create/generate refused", async () => {
    const { proxy } = await import("@/proxy");
    // The Accountant runs it and generates a 2316 and the alphalist.
    await runAnnualization("2026-12-20T10:00:00+08:00");
    expect((await (await birForms()).GET(request(`/api/payroll/bir-forms?year=2026&format=pdf&employee_id=${BEN_UUID}`))).status).toBe(200);
    expect((await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026&format=csv"))).status).toBe(200);
    const records = structuredClone(table("payroll_tax_annualizations"));
    const exports = structuredClone(table("payroll_bir_exports"));
    const calls = rpc.calls.length;

    // Read: records of every branch, flagged read-only, nothing to schedule on.
    const view = await (await (await yearEnd()).GET(request("/api/payroll/year-end-tax?year=2026", "GET", null, SUPER))).json();
    expect(view).toMatchObject({ read_only: true, targets: [] });
    expect(view.rows.map((r) => r.employee_name).sort()).toEqual(["Ana Clean", "Ben Mixed", "Cara Untaxed"]);
    expect(view.rows[0].branch_name).toBe("Pasig");
    const list = await (await (await import("@/app/api/payroll/bir-exports/route")).GET(request("/api/payroll/bir-exports?year=2026", "GET", null, SUPER))).json();
    expect(list.read_only).toBe(true);
    expect(list.exports.map((e) => `${e.kind}/${e.format}/${e.branch_name}`).sort()).toEqual(["alphalist/csv/All branches", "bir_2316/pdf/Pasig"]);
    const pdf = await (await import("@/app/api/payroll/bir-exports/route")).GET(request(`/api/payroll/bir-exports?id=${list.exports.find((e) => e.kind === "bir_2316").id}`, "GET", null, SUPER));
    expect(pdf.status).toBe(200);
    const text = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    expect(text).toContain("(Mixed, Ben)");
    // The TIN comes from the encrypted profile, not the stored file.
    expect(text).toContain("(123-456-781-00000)");
    expect(JSON.stringify(table("payroll_bir_exports"))).not.toContain("123456781");
    for (const [path, method] of READ) {
      expect((await proxy(proxyRequest(path, method, null, SUPER))).status, `proxy super_admin ${path}`).toBe(200);
    }

    // Generate / change: refused at the route, and the proxy.
    for (const [path, method, body] of GENERATE) {
      expect((await (await moduleFor(path))[method](request(path, method, body, SUPER))).status, `super_admin ${method} ${path}`).toBe(403);
      expect((await proxy(proxyRequest(path, method, body, SUPER))).status, `proxy super_admin ${method} ${path}`).toBe(403);
    }
    // The exports route has nothing but GET.
    const exportsRoute = await import("@/app/api/payroll/bir-exports/route");
    expect(exportsRoute.POST || exportsRoute.PATCH || exportsRoute.PUT || exportsRoute.DELETE).toBeUndefined();
    // Nothing was computed, saved or changed by the Super Admin.
    expect(rpc.calls.slice(calls).map((c) => c.fn).filter((fn) => fn !== "payroll_bir_read_scope" && fn !== "get_profiles_pii")).toEqual([]);
    expect(table("payroll_tax_annualizations")).toEqual(records);
    expect(table("payroll_bir_exports")).toEqual(exports);
  });

  it("Accountant: annualization, the summary and the 2316 stay on its branch; the alphalist covers every branch", async () => {
    const { proxy } = await import("@/proxy");
    vi.setSystemTime(new Date("2026-12-20T10:00:00+08:00"));
    expect((await proxy(proxyRequest("/api/payroll/year-end-tax?year=2026", "GET", null, ACCOUNTANT))).status).toBe(200);
    const mine = await runAnnualization("2026-12-20T10:00:00+08:00");
    // Annualization: its branch only (Dan, of the other branch, is not in it).
    expect(mine.rows.map((r) => r.employee_name).sort()).toEqual(["Ana Clean", "Ben Mixed", "Cara Untaxed"]);
    // Summary and 2316: its branch only.
    const summary = await (await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026"))).json();
    expect(summary.rows.map((r) => r.full_name)).not.toContain("Dan North");
    expect((await (await birForms()).GET(request(`/api/payroll/bir-forms?year=2026&format=pdf&employee_id=${DAN_UUID}`))).status).toBe(404);
    // Alphalist: every branch, Dan included.
    const csv = await (await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026&format=csv"))).text();
    expect(csv).toContain(",North,Dan,");
    expect(csv).toContain(",Mixed,Ben,");
    const xlsx = await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026&format=xlsx"));
    expect(xlsx.status).toBe(200);
    expect(table("payroll_bir_exports").filter((e) => e.kind === "alphalist").every((e) => e.scope === "school" && e.rows.some((r) => r.employee_id === DAN_UUID))).toBe(true);

    // The other branch's Accountant: none of these records, cannot schedule them.
    const far = await (await (await yearEnd()).GET(request("/api/payroll/year-end-tax?year=2026", "GET", null, OTHER_ACCOUNTANT))).json();
    expect(far.rows).toEqual([]);
    const farFiles = await (await (await import("@/app/api/payroll/bir-exports/route")).GET(request("/api/payroll/bir-exports?year=2026", "GET", null, OTHER_ACCOUNTANT))).json();
    expect(farFiles.exports).toEqual([]);
    // Its own alphalist is school-wide too.
    const farCsv = await (await (await birForms()).GET(request("/api/payroll/bir-forms?year=2026&format=csv", "GET", null, OTHER_ACCOUNTANT))).text();
    expect(farCsv).toContain(",Mixed,Ben,");
    // Processing payroll stays on its branch.
    vi.setSystemTime(new Date("2026-12-16T10:00:00+08:00"));
    const processed = await (await payrollRoute.POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: DEC1, entries: [{ employee_id: BEN_UUID }] }, OTHER_ACCOUNTANT))).json();
    expect(processed.processed || []).toHaveLength(0);

    const bad = await (await yearEnd()).POST(request("/api/payroll/year-end-tax", "POST", { action: "schedule", id: mine.rows[0].id, period: "December 1-15, 2026" }));
    expect(bad.status).toBe(400);
    rpc.results.payroll_tax_annualization_schedule = { data: null, error: { message: "forbidden: that employee is not in your branch." } };
    const refused = await (await yearEnd()).POST(request("/api/payroll/year-end-tax", "POST", { action: "schedule", id: mine.rows[0].id, period: DEC2 }, OTHER_ACCOUNTANT));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("That employee is not in your branch.");
  });
});

describe("the remittance report (Fix 1)", () => {
  it("adds the year-end adjustment of the month's payslips to the tax remitted", async () => {
    await batch(DEC1, "2026-12-16T10:00:00+08:00");
    const first = await runAnnualization("2026-12-20T10:00:00+08:00");
    await scheduleAll(first);
    await batch(DEC2, "2027-01-02T10:00:00+08:00");
    const { GET: report } = await import("@/app/api/payroll/remittance/route");
    const body = await (await report(request("/api/payroll/remittance?month=2026-12"))).json();
    const row = (id) => body.rows.find((r) => r.employee_id === id);
    // Regular December tax, and the adjustment on its own: Ben −234.43, Cara +9,067.35, Ana −0.60.
    expect(row(BEN_UUID)).toMatchObject({ withholding_tax: 1307.55, year_end_tax: -234.43 });
    expect(row(CARA_UUID)).toMatchObject({ withholding_tax: 1007.55, year_end_tax: 9067.35 });
    expect(row(ANA_UUID)).toMatchObject({ withholding_tax: 1007.55, year_end_tax: -0.6 });
    // Cara remits SSS 1,500 + PhilHealth 750 + Pag-IBIG 200 (+ employer shares) + 1,007.55 + 9,067.35.
    const cara = row(CARA_UUID);
    expect(cara.total_remit).toBe(Math.round((cara.sss_total + cara.philhealth_total + cara.pagibig_total + 1007.55 + 9067.35) * 100) / 100);
    expect(body.totals.year_end_tax).toBe(8832.32);
    const csv = await (await report(request("/api/payroll/remittance?month=2026-12&format=csv"))).text();
    expect(csv.split("\n")[0]).toContain('"Withholding tax (BIR)","Year-end tax adjustment (BIR, + collected / - refunded)","Total remit"');
    // November (no adjustment) is as before.
    expect((await (await report(request("/api/payroll/remittance?month=2026-11"))).json()).totals.year_end_tax).toBe(0);
  });
});

describe("final pay of a separated employee (Fix 2)", () => {
  it("settles the pending year-end tax on the final pay, as its own line", async () => {
    // Ana resigns on Dec 5 with her annualization run (Jan-Nov).
    const ana = table("profiles").find((p) => p.id === ANA_UUID);
    Object.assign(ana, { employee_status: "Separated", separated_on: "2026-12-05", separation_reason: "Resigned" });
    Object.assign(users.find((u) => u.id === ANA_UUID).user_metadata, { employee_status: "Separated", separated_on: "2026-12-05" });
    const run = await runAnnualization("2026-12-06T10:00:00+08:00");
    expect(run.rows.find((r) => r.employee_id === ANA_UUID)).toMatchObject({ balance: -3125.55 });
    const before = structuredClone(table("payroll_entries"));

    vi.setSystemTime(new Date("2026-12-10T10:00:00+08:00"));
    const finalPay = await import("@/app/api/accountant/final-pay/route");
    const preview = await (await finalPay.GET(request(`/api/accountant/final-pay?employee_id=${ANA_UUID}`))).json();
    // Final pay: Dec 1-4 = 4 paid days × 1,379.31 = 5,517.24; taxable 5,517.24 − 2,450 = 3,067.24 (tax 0).
    // Year: 303,050 + 3,067.24 = 306,117.24 → due (306,117.24 − 250,000) × 15% = 8,417.59; withheld 11,083.05 → refund 2,665.46.
    const line = preview.breakdown.deductions.find((d) => d.kind === "year_end_tax");
    expect(line).toMatchObject({ amount: 2665.46, credit: true, label: "Year-end tax adjustment 2026 (refund)" });
    expect(preview.breakdown.deductions.filter((d) => d.kind === "withholding_tax")).toEqual([]);

    const saved = await finalPay.POST(request("/api/accountant/final-pay", "POST", { employee_id: ANA_UUID, release_on: "2026-12-10" }));
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    const entry = table("payroll_entries").find((e) => e.employee_id === ANA_UUID && e.pay_period.startsWith("Final pay"));
    expect(entry.payroll.year_end_tax).toMatchObject({ kind: "refund", amount: 2665.46, signed: -2665.46, tax_due: 8417.59, taxable: 306117.24, withheld_before: 11083.05 });
    const fp = entry.payroll.final_pay.breakdown;
    // Net = earnings − regular deductions + the refund.
    const earned = fp.earnings.reduce((s, e) => s + e.amount, 0);
    const regular = fp.deductions.filter((d) => !d.credit).reduce((s, d) => s + d.amount, 0);
    expect(entry.payroll.totals.net_pay).toBe(Math.round((earned - regular + 2665.46) * 100) / 100);
    expect(table("payroll_incentives").filter((l) => l.type === "year_end_tax_refund").map((l) => l.amount)).toEqual([2665.46]);
    // Nothing earlier changed.
    expect(table("payroll_entries").filter((e) => before.some((b) => b.id === e.id))).toEqual(before);

    // Re-run: settled. The remittance report of December carries the refund.
    const again = await runAnnualization("2026-12-11T10:00:00+08:00");
    expect(again.rows.find((r) => r.employee_id === ANA_UUID)).toMatchObject({ tax_due: 8417.59, adjustments_settled: -2665.46, balance: 0 });
    const { GET: report } = await import("@/app/api/payroll/remittance/route");
    const body = await (await report(request("/api/payroll/remittance?month=2026-12"))).json();
    expect(body.rows.find((r) => r.employee_id === ANA_UUID)).toMatchObject({ year_end_tax: -2665.46, withholding_tax: 0 });
  });

  it("leaves the final pay as before when no annualization was run", async () => {
    Object.assign(table("profiles").find((p) => p.id === ANA_UUID), { employee_status: "Separated", separated_on: "2026-12-05" });
    vi.setSystemTime(new Date("2026-12-10T10:00:00+08:00"));
    const finalPay = await import("@/app/api/accountant/final-pay/route");
    const preview = await (await finalPay.GET(request(`/api/accountant/final-pay?employee_id=${ANA_UUID}`))).json();
    expect(preview.breakdown.deductions.some((d) => d.kind === "year_end_tax")).toBe(false);
    expect(preview.breakdown.year_end_tax).toBeUndefined();
  });
});
