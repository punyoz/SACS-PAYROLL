/**
 * READ-ONLY AUDIT (2026-11-16): are a semi-monthly month's contributions and
 * withholding tax correct as a MONTH total? Fake employees, the real Process
 * Payroll route (POST batch_submit) on the in-memory database, with the live
 * rate tables (copied 2026-11-16: SSS 5% / ER 10% + EC, salary-credit table
 * of 61 rows, PhilHealth 2.5% within ₱10,000–₱100,000, Pag-IBIG 2% up to
 * ₱10,000, BIR monthly table, 261 working days a year, overtime premium 0%).
 *
 * The expected figures are computed independently below (hand formulas from
 * the official tables, not the app's functions). Every case is written to
 * AUDIT_OUT (JSON) for the report; a case fails only on a centavo difference.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { resetDb, table, users } from "./helpers/fake-supabase.js";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const OUT = process.env.AUDIT_OUT || null;
const results = [];

// ── Hand formulas (official tables) ─────────────────────────────────────────
// Half-up on the decimal value (904.095 → 904.10), free of binary float error.
const r2 = (v) => Math.round(Number(Number(v).toFixed(6)) * 100 + 1e-9) / 100;
const msc = (x) => (x < 5250 ? 5000 : Math.min(35000, 5500 + 500 * Math.floor((x - 5250) / 500)));
const eeMonthly = (salary) => ({
  sss: r2(msc(salary) * 0.05),
  philhealth: r2(Math.min(Math.max(salary, 10000), 100000) * 0.025),
  pagibig: r2(Math.min(salary, 10000) * (salary <= 1500 ? 0.01 : 0.02)),
});
const erMonthly = (salary) => ({
  sss: r2(msc(salary) * 0.10),
  ec: msc(salary) >= 15000 ? 30 : 10,
  philhealth: r2(Math.min(Math.max(salary, 10000), 100000) * 0.025),
  pagibig: r2(Math.min(salary, 10000) * 0.02),
});
const BIR = [[0, 0, 0], [20833, 0, 0.15], [33333, 1875, 0.20], [66667, 8541.8, 0.25], [166667, 33541.8, 0.30], [666667, 183541.8, 0.35]];
const monthlyTax = (taxable) => { let b = BIR[0]; BIR.forEach((row) => { if (taxable > row[0]) b = row; }); return r2(b[1] + (taxable - b[0]) * b[2]); };
const daily = (salary) => r2((salary * 12) / 261);
const hourly = (salary) => r2(daily(salary) / 8);
const weekdays = (from, to) => { let n = 0; for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) n += 1; return n; };

// ── Harness ──────────────────────────────────────────────────────────────────
const LEGAL = { sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000, philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000 };
const EMPLOYER = { sss_er_pct: 10, sss_ec_low: 10, sss_ec_high: 30, sss_ec_threshold: 15000, philhealth_er_pct: 2.5, pagibig_er_pct: 2 };
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
const rate = (rateType, value, effectiveDate = "2026-10-01") => ({ id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z` });

let POST;
let createSessionToken;
let SESSION_COOKIE;
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Audit Accountant" };
const request = (url, method, body) => {
  const req = new Request(`https://sacs.test${url}`, { method, headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: "s-acct", email: "acct@sacs.test", ...ACCOUNTANT })}` }, body: body ? JSON.stringify(body) : undefined });
  req.nextUrl = new URL(req.url);
  return req;
};
const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);

function person(id, salary, extra = {}) {
  users.push({ id, email: `${id}@sacs.test`, user_metadata: { role: "employee", full_name: id, employee_id: id, basic_salary: salary, branch_id: BRANCH } });
  table("profiles").push({ id, full_name: `Fake ${id}`, email: `${id}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: id, archived: false, basic_salary: salary, date_hired: "2024-06-01", ...extra });
}
function absent(id, from, to) {
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (!(d.getUTCDay() % 6)) continue;
    const key = d.toISOString().slice(0, 10);
    table("attendance_logs").push({ id: `abs-${id}-${key}`, employee_id: id, log_date: key, time_in: null, time_out: null, created_at: `${key}T00:00:00Z`, status: "Absent", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, branch_id: BRANCH, archived_duplicate: false });
  }
}
function overtime(id, key, minutes) {
  const logId = `ot-${id}-${key}`;
  table("attendance_logs").push({ id: logId, employee_id: id, branch_id: BRANCH, log_date: key, time_in: `${key}T00:00:00Z`, time_out: `${key}T13:00:00Z`, created_at: `${key}T00:00:00Z`, status: "On Time", late_minutes: 0, undertime_minutes: 0, is_half_day: false, is_early_bird: false, archived_duplicate: false, arrival_offset_minutes: 0 });
  table("attendance_overtime_approvals").push({ log_id: logId, employee_id: id, log_date: key, overtime_minutes: minutes, approved_minutes: minutes, status: "approved" });
}
function incentive(id, key, amount) {
  table("payroll_monthly_incentives").push({ id: `inc-${id}-${key}`, employee_id: id, item_date: key, kind: "incentive", description: "Audit incentive", amount, hours: null, archived: false, created_at: `${key}T02:00:00Z` });
}
async function processHalf(label, at, ids) {
  vi.setSystemTime(new Date(at));
  const body = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: label, entries: ids.map((employee_id) => ({ employee_id })) }))).json();
  // HR approval: the payslip is Final (status paid) for the 2nd half to read.
  table("payroll_entries").filter((e) => e.pay_period === label).forEach((e) => { e.status = "paid"; });
  return body;
}
const MONTHS = {
  "2026-11": ["November 1-15, 2026", "2026-11-16T10:00:00+08:00", "November 16-30, 2026", "2026-12-01T10:00:00+08:00"],
  "2026-12": ["December 1-15, 2026", "2026-12-16T10:00:00+08:00", "December 16-31, 2026", "2027-01-02T10:00:00+08:00"],
  "2027-02": ["February 1-15, 2027", "2027-02-16T10:00:00+08:00", "February 16-28, 2027", "2027-03-01T10:00:00+08:00"],
};
async function processMonth(monthKey, ids) {
  const [l1, t1, l2, t2] = MONTHS[monthKey];
  const one = await processHalf(l1, t1, ids);
  const two = await processHalf(l2, t2, ids);
  return { l1, l2, one, two };
}

/** The month as the system stored it: 1st half and 2nd half deductions, employer shares. */
function stored(id, l1, l2) {
  const a = entry(id, l1)?.payroll;
  const b = entry(id, l2)?.payroll;
  const ded = (p) => ({ sss: r2(p?.deductions?.sss || 0), philhealth: r2(p?.deductions?.philhealth || 0), pagibig: r2(p?.deductions?.pagibig || 0), tax: r2(p?.deductions?.withholding_tax || 0) });
  const er = (p) => p?.employer_contributions?.employer || { sss: 0, sss_ec: 0, philhealth: 0, pagibig: 0, total: 0 };
  return {
    first: ded(a), second: ded(b),
    first_gross: r2(a?.totals?.gross_pay || 0), second_gross: r2(b?.totals?.gross_pay || 0), month_gross: r2(b?.monthly?.monthly_gross || 0),
    first_net: r2(a?.totals?.net_pay || 0), second_net: r2(b?.totals?.net_pay || 0), carry_out: r2(b?.monthly?.carry_over_out || 0),
    er_first: er(a), er_second: er(b), taxable: r2(b?.monthly?.taxable_income || 0),
    first_shows_employer: /employer/.test(JSON.stringify(a?.totals || {}) + JSON.stringify(a?.deductions || {})),
  };
}

function record(name, id, s, expected) {
  const total = (k) => r2(s.first[k] + s.second[k]);
  const month = { sss: total("sss"), philhealth: total("philhealth"), pagibig: total("pagibig"), tax: total("tax") };
  const diff = Object.fromEntries(Object.keys(month).map((k) => [k, r2(month[k] - expected[k])]));
  const erTotal = { sss: r2((s.er_first.sss || 0) + (s.er_second.sss || 0)), ec: r2((s.er_first.sss_ec || 0) + (s.er_second.sss_ec || 0)), philhealth: r2((s.er_first.philhealth || 0) + (s.er_second.philhealth || 0)), pagibig: r2((s.er_first.pagibig || 0) + (s.er_second.pagibig || 0)) };
  const erDiff = expected.er ? Object.fromEntries(Object.keys(erTotal).map((k) => [k, r2(erTotal[k] - expected.er[k])])) : null;
  const netExpected = expected.net;
  const netStored = r2(s.first_net + s.second_net - (s.carry_out || 0)); // a carry-over is owed next month
  const pass = Object.values(diff).every((v) => v === 0) && (!erDiff || Object.values(erDiff).every((v) => v === 0))
    && (netExpected === undefined || r2(netStored - netExpected) === 0) && (expected.gross === undefined || r2(s.month_gross - expected.gross) === 0);
  const row = { case: name, employee: id, month_gross: s.month_gross, expected_gross: expected.gross, first_half_gross: s.first_gross, second_half_gross: s.second_gross,
    first: s.first, second: s.second, month, expected: { sss: expected.sss, philhealth: expected.philhealth, pagibig: expected.pagibig, tax: expected.tax }, diff,
    employer_saved: { first: s.er_first, second: s.er_second, month: erTotal }, employer_expected: expected.er || null, employer_diff: erDiff,
    net_month: netStored, net_expected: netExpected, carry_out: s.carry_out, taxable: s.taxable, note: expected.note || null, pass };
  results.push(row);
  return row;
}
const expectFor = (salary, gross, note, base = salary) => {
  const c = eeMonthly(base);
  const contributions = r2(c.sss + c.philhealth + c.pagibig);
  const taxable = Math.max(0, r2(gross - contributions));
  const tax = monthlyTax(taxable);
  const e = erMonthly(base);
  return { ...c, tax, gross, net: r2(gross - contributions - tax), er: { sss: e.sss, ec: e.ec, philhealth: e.philhealth, pagibig: e.pagibig }, note };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-semi-monthly-audit";
  resetDb();
  table("profiles").push({ id: "u-acct", branch_id: BRANCH, role: "accountant" });
  table("payroll_rate_configs").push(
    rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("early_bird_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("overtime_premium_pct", 0), rate("overload_premium_pct", 0),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("benefits_exempt_ceiling", 90000, "2018-01-01"), rate("contribution_method", 0),
    ...Object.entries(LEGAL).map(([type, value]) => rate(type, value)),
    ...Object.entries(EMPLOYER).map(([type, value]) => rate(type, value, "2025-01-01")),
  );
  table("payroll_tax_brackets").push(...BIR.map(([over, base, r]) => ({ id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: r * 100, created_at: "2023-01-01T00:00:00Z" })));
  table("payroll_sss_msc_brackets").push(...MSC_ROWS);
  const route = await import("@/app/api/accountant/payroll/route");
  POST = route.POST;
  POST.__patch = route.PATCH;
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});
afterEach(() => {
  vi.useRealTimers();
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
});

describe("Case 1: equal halves (November 2026, 30 days)", () => {
  it.each([[12000], [18000], [30000], [45000]])("₱%i a month", async (salary) => {
    const id = `eq-${salary}`;
    person(id, salary);
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const row = record(`1 equal halves ₱${salary}`, id, stored(id, l1, l2), expectFor(salary, salary));
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
});

describe("Case 2: uneven month", () => {
  it("1st half lower (3 days absent Nov 3-5), 2nd half higher (₱6,000 taxable incentive)", async () => {
    const id = "uneven-low-high"; const salary = 30000;
    person(id, salary); absent(id, "2026-11-03", "2026-11-05"); incentive(id, "2026-11-20", 6000);
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const gross = r2(salary - 3 * daily(salary) + 6000);
    const row = record("2a 1st lower / 2nd higher ₱30,000", id, stored(id, l1, l2), expectFor(salary, gross, "SSS/PhilHealth on the monthly basic (system method); the ₱6,000 incentive is taxed but not in the SSS base"));
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
  it("1st half higher (12 h approved overtime Nov 2-13), 2nd half lower (2 days absent Nov 17-18)", async () => {
    const id = "uneven-high-low"; const salary = 30000;
    person(id, salary);
    ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"].forEach((k) => overtime(id, k, 120));
    absent(id, "2026-11-17", "2026-11-18");
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const gross = r2(salary + r2(12 * hourly(salary)) - 2 * daily(salary));
    const row = record("2b 1st higher (overtime) / 2nd lower ₱30,000", id, stored(id, l1, l2), expectFor(salary, gross, "overtime at 0% premium = hourly × hours"));
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
});

describe("Case 3: the 1st half alone is a different bracket than the month", () => {
  it.each([[30000], [45000], [12000]])("₱%i: the month's bracket, never the half's", async (salary) => {
    const id = `bracket-${salary}`;
    person(id, salary);
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const s = stored(id, l1, l2);
    // What a per-half computation (each half on its own gross) would have given, for the report.
    const half = eeMonthly(salary / 2);
    const perHalf = { sss: r2(half.sss * 2), philhealth: r2(half.philhealth * 2), pagibig: r2(half.pagibig * 2) };
    const halfTax = (() => { const t = r2(salary / 2 - (half.sss + half.philhealth + half.pagibig)); return r2(2 * monthlyTax(t * 2) / 2); })();
    const row = record(`3 bracket ₱${salary} (half ₱${salary / 2})`, id, s, { ...expectFor(salary, salary), note: `per-half basis would give SSS ${perHalf.sss}, PhilHealth ${perHalf.philhealth}, Pag-IBIG ${perHalf.pagibig}` });
    row.per_half_alternative = { ...perHalf, half_msc: msc(salary / 2), month_msc: msc(salary), approx_tax: halfTax };
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
});

describe("Case 4: mid-month events", () => {
  it("hired Tue Nov 10 (₱30,000): paid by the day; contributions on the FULL monthly salary (system method)", async () => {
    const id = "hire-10"; const salary = 30000;
    person(id, salary, { date_hired: "2026-11-10" });
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const days = weekdays("2026-11-10", "2026-11-30");
    const gross = Math.min(r2(days * daily(salary)), salary);
    const s = stored(id, l1, l2);
    const row = record("4a hire Nov 10 ₱30,000", id, s, expectFor(salary, gross, `${days} paid days × ${daily(salary)}; contributions on the full ₱30,000, not the ₱${gross} earned`));
    row.if_on_earnings = (() => { const c = eeMonthly(gross); return { ...c, total: r2(c.sss + c.philhealth + c.pagibig) }; })();
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
  it("absent every weekday of the 2nd half (Nov 16-30, ₱18,000)", async () => {
    const id = "unpaid-2nd"; const salary = 18000;
    person(id, salary); absent(id, "2026-11-16", "2026-11-30");
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const days = weekdays("2026-11-16", "2026-11-30");
    const gross = r2(salary - Math.min(salary, days * daily(salary)));
    const row = record(`4b 2nd half all absent (${days} days) ₱18,000`, id, stored(id, l1, l2), expectFor(salary, gross, "full month's contributions still taken (the month has earnings)"));
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
  it("absent every weekday of November (₱18,000): a sliver of gross remains at 261 days a year", async () => {
    const id = "unpaid-month"; const salary = 18000;
    person(id, salary); absent(id, "2026-11-01", "2026-11-30");
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const days = weekdays("2026-11-01", "2026-11-30");
    const gross = r2(salary - Math.min(salary, days * daily(salary)));
    const row = record(`4c whole month absent (${days} days) ₱18,000`, id, stored(id, l1, l2), expectFor(salary, gross, "gross > 0, so the full monthly contributions are deducted and the shortfall carries over"));
    expect(row.pass, JSON.stringify(row)).toBe(true);
  });
  it("February 2027 (28 days) and December 2026 (31 days), ₱30,000", async () => {
    for (const mk of ["2026-12", "2027-02"]) {
      const id = `month-${mk}`; const salary = 30000;
      person(id, salary);
      const { l1, l2 } = await processMonth(mk, [id]);
      const row = record(`4d ${mk} ₱30,000`, id, stored(id, l1, l2), expectFor(salary, salary));
      expect(row.pass, JSON.stringify(row)).toBe(true);
    }
  });
});

describe("Case 5: a 1st half reprocessed after the 2nd half", () => {
  it("2 days absent added to the 1st half after the 2nd half was Final: the 2nd half is flagged, nothing changes by itself", async () => {
    const id = "reproc"; const salary = 30000;
    person(id, salary);
    const { l1, l2 } = await processMonth("2026-11", [id]);
    const before = JSON.parse(JSON.stringify(entry(id, l2).payroll));
    // HR rejects the 1st half; the Accountant reprocesses it with 2 absences found later.
    absent(id, "2026-11-05", "2026-11-06");
    table("payroll_runs").push({ id: "run-first", branch_id: BRANCH, period_label: l1, period_start: "2026-11-01", period_end: "2026-11-15", cutoff_type: "first", status: "rejected", run_no: 1, submission_no: 1, created_at: "2026-11-16T00:00:00Z" });
    entry(id, l1).run_id = "run-first";
    vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
    const reproc = await POST.__patch(request("/api/accountant/payroll", "PATCH", { action: "generate", reprocess: true, employee_id: id, pay_period: l1 }));
    const reprocBody = await reproc.json();
    const { firstHalfChange } = await import("@/lib/payroll/run-roster");
    const change = firstHalfChange(entry(id, l2), entry(id, l1));
    const after = entry(id, l2).payroll;
    const s = stored(id, l1, l2);
    const gross = r2(salary - 2 * daily(salary));
    const row = record("5 1st half reprocessed (2 days absent) ₱30,000", id, s, { ...expectFor(salary, gross), note: "expected = the corrected month; the stored 2nd half still has the old 1st half until it is recomputed" });
    row.second_half_unchanged = JSON.stringify(before.deductions) === JSON.stringify(after.deductions);
    row.first_half_change_flag = change;
    row.reprocess_response = { status: reproc.status, error: reprocBody.error || null, code: reprocBody.code || null };
    row.first_half_net_after = r2(entry(id, l1).payroll.totals.net_pay);
    expect(row.second_half_unchanged).toBe(true);
  });
});

describe("Year-end: 12 months of 2027 against the annualization (BIR 2316)", () => {
  it("₱30,000 and ₱45,000 every month: withheld = annual tax due", async () => {
    const ids = ["ye-30000", "ye-45000"];
    person(ids[0], 30000); person(ids[1], 45000);
    const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (let m = 1; m <= 12; m += 1) {
      const last = new Date(Date.UTC(2027, m, 0)).getUTCDate();
      const next = m === 12 ? "2028-01-02" : `2027-${String(m + 1).padStart(2, "0")}-01`;
      await processHalf(`${MONTH[m - 1]} 1-15, 2027`, `2027-${String(m).padStart(2, "0")}-16T10:00:00+08:00`, ids);
      await processHalf(`${MONTH[m - 1]} 16-${last}, 2027`, `${next}T10:00:00+08:00`, ids);
    }
    const { compute2316, payslipFigures, annualTaxDue } = await import("@/lib/payroll/bir-2316");
    const tableRows = BIR.map(([over, base, r]) => ({ over, base, rate: r }));
    for (const id of ids) {
      const slips = table("payroll_entries").filter((e) => e.employee_id === id && /2027$/.test(e.pay_period));
      const withheld = r2(slips.reduce((s, e) => s + Number(e.payroll?.deductions?.withholding_tax || 0), 0));
      const form = compute2316({ year: 2027, employee: { date_hired: "2024-06-01" }, payslips: slips.map((e) => ({ ...e, figures: payslipFigures(e) })), benefits: [], taxTable: tableRows });
      const salary = Number(id.split("-")[1]);
      const c = eeMonthly(salary);
      const annualTaxable = r2(12 * (salary - c.sss - c.philhealth - c.pagibig));
      const expectedDue = annualTaxDue(annualTaxable, tableRows);
      const b = form.boxes;
      results.push({ case: `year-end 2027 ${id}`, employee: id, payslips: slips.length, withheld_regular: withheld, form_withheld_regular: form.withheld_regular, box36_contributions: b[36], box21_taxable: b[21], box24_tax_due: b[24], box25A_withheld: b["25A"], difference: form.difference, settlement: form.settlement, hand_annual_contributions: r2(12 * (c.sss + c.philhealth + c.pagibig)), hand_annual_taxable: annualTaxable, hand_annual_due: expectedDue, sum_of_monthly_taxes: r2(12 * monthlyTax(r2(salary - c.sss - c.philhealth - c.pagibig))), pass: r2(b[21] - annualTaxable) === 0 && r2(b[24] - expectedDue) === 0 && r2(b["25A"] - withheld) === 0 });
      expect(slips).toHaveLength(24);
    }
  }, 120000);
});

describe("Case 4e: separated Sun Nov 22, 2026 (Final Pay, ₱30,000; 1st half ₱15,000 paid)", () => {
  it("the separation month settles its contributions and tax once, on the month's earnings", async () => {
    const { computeFinalPay } = await import("@/lib/payroll/final-pay");
    const { monthlyContributionsFor } = await import("@/lib/payroll/school-sheet");
    const salary = 30000;
    const rates = { ...LEGAL, contribution_method: 0 };
    const mscTable = MSC_ROWS.map((r) => ({ from: r.salary_from, msc: r.msc }));
    const contributions = monthlyContributionsFor(salary, rates, {}, { mscTable });
    const paidDays = weekdays("2026-11-01", "2026-11-22");
    const out = computeFinalPay({
      monthlySalary: salary, dailyRate: daily(salary), separatedOn: "2026-11-22",
      months: [{ month_key: "2026-11", window: { start_key: "2026-11-01", end_key: "2026-11-30" }, absent_days: 0, first_half_paid: 15000, first_half_basic: 15000, partial: { paid: paidDays, unpaid_holidays: [] } }],
      contributions, taxTable: BIR.map(([over, base, r]) => ({ over, base, rate: r })), basicEarnedYtd: 15000 * 21, thirteenthPaid: true, subsidy: null, benefitsYtd: 0, ceiling: 90000, carryIn: 0, loans: [],
    });
    const earned = r2(paidDays * daily(salary));
    const exp = expectFor(salary, earned, `separation month: ${paidDays} paid days × ${daily(salary)}; contributions on the full monthly salary`);
    const got = (k) => r2(out.deductions.filter((d) => d.kind === k).reduce((s, d) => s + d.amount, 0));
    const month = { sss: got("sss"), philhealth: got("philhealth"), pagibig: got("pagibig"), tax: got("withholding_tax") };
    const diff = Object.fromEntries(Object.keys(month).map((k) => [k, r2(month[k] - exp[k])]));
    results.push({ case: "4e separated Nov 22 (Final Pay) ₱30,000", employee: "sep-22", month_gross: earned, expected_gross: earned, first: { sss: 0, philhealth: 0, pagibig: 0, tax: 0 }, second: month, month, expected: { sss: exp.sss, philhealth: exp.philhealth, pagibig: exp.pagibig, tax: exp.tax }, diff, note: exp.note, if_on_earnings: eeMonthly(earned), pass: Object.values(diff).every((v) => v === 0) });
    expect(Object.values(diff).every((v) => v === 0), JSON.stringify(month)).toBe(true);
  });
});
