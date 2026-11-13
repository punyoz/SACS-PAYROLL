/**
 * Contributions apart from withholding tax, and a type tag + "how it was
 * computed" on every line (2026-11-03, src/lib/payroll/line-tags.js).
 *
 * October 16-31, 2026 with the live settings (percentages, the 2025 SSS
 * salary credit table, the BIR monthly table):
 *   ₱18,500  the employee on the Process Payroll screen (₱9,250 per half):
 *            SSS 5% × 18,500 = 925, PhilHealth 2.5% × 18,500 = 462.50,
 *            Pag-IBIG 2% × 10,000 (cap) = 200; taxable 16,912.50 < 20,833 → ₱0
 *   ₱45,000  SSS at the ₱35,000 ceiling (1,750), PhilHealth 1,125, Pag-IBIG 200;
 *            taxable 41,925 → 1,875 + 20% × (41,925 − 33,333) = 3,593.40
 *   ₱8,000   PhilHealth on the ₱10,000 floor (250), Pag-IBIG 2% × 8,000 = 160
 * Nothing here changes an amount: the tests compare against the engine's own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { computeSummary, defaultForm } from "@/lib/portal/payroll-preview";
import { previewLineGroups } from "@/lib/portal/payroll-line-preview";
import { DEFERRED_NOTE, LINE_TAGS, buildLineGroups, linesNet, payrollLineGroups, taxExplanation } from "@/lib/payroll/line-tags";
import { buildPayslipDetails } from "@/lib/payroll/payslip-details";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const FIRST = "October 1-15, 2026";
const SECOND = "October 16-31, 2026";
const PEOPLE = [
  { id: "u-mid", name: "Mara Mid", code: "SACS-501", salary: 18500 },
  { id: "u-high", name: "Hal High", code: "SACS-502", salary: 45000 },
  { id: "u-low", name: "Lia Floor", code: "SACS-503", salary: 8000 },
];
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
const rate = (rateType, value, effectiveDate = "2026-10-01", createdAt = `${effectiveDate}T00:00:00Z`) => ({
  id: `cfg-${rateType}-${effectiveDate}-${createdAt}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: createdAt,
});

let GET;
let POST;
let createSessionToken;
let SESSION_COOKIE;
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Payroll JM" };
const request = (url, method = "GET", body, who = ACCOUNTANT) => new Request(`https://sacs.test${url}`, {
  method,
  headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: `s-${who.user_id}`, email: `${who.user_id}@sacs.test`, ...who })}` },
  body: body ? JSON.stringify(body) : undefined,
});
const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);

function seed() {
  table("payroll_rate_configs").push(
    rate("daily", 600), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("benefits_exempt_ceiling", 90000, "2018-01-01"),
    rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2), rate("sss_msc_min", 5000), rate("sss_msc_max", 35000),
    rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
    rate("sss_er_pct", 10), rate("philhealth_er_pct", 2.5), rate("pagibig_er_pct", 2), rate("sss_ec_low", 10), rate("sss_ec_high", 30), rate("sss_ec_threshold", 15000),
    rate("contribution_method", 0, "2026-10-16"),
  );
}

async function processFirstHalf() {
  vi.setSystemTime(new Date("2026-10-16T10:00:00+08:00"));
  const body = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: FIRST, entries: PEOPLE.map((p) => ({ employee_id: p.id })) }))).json();
  expect(body.processed).toHaveLength(PEOPLE.length);
  vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
}

async function preview(id) {
  const data = await (await GET(request(`/api/accountant/payroll?period=${encodeURIComponent(SECOND)}`))).json();
  const employee = data.employees.find((e) => e.id === id);
  const form = defaultForm(data, employee);
  const summary = computeSummary(data, employee, form);
  return { data, employee, form, summary, groups: previewLineGroups(data, employee, form, summary, form) };
}

const lineIn = (result, group, key) => result.groups.find((g) => g.key === group).lines.find((l) => l.key === key);
const allLines = (result) => result.groups.flatMap((g) => g.lines);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-line-tags";
  resetDb();
  table("profiles").push({ id: "u-acct", branch_id: BRANCH, role: "accountant", full_name: "Payroll JM" });
  PEOPLE.forEach((p) => {
    users.push({ id: p.id, email: `${p.code}@sacs.test`, user_metadata: { role: "employee", full_name: p.name, employee_id: p.code, basic_salary: p.salary, branch_id: BRANCH } });
    table("profiles").push({ id: p.id, full_name: p.name, email: `${p.code}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: p.code, archived: false, basic_salary: p.salary, date_hired: "2024-06-01" });
  });
  table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
    id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
  })));
  table("payroll_sss_msc_brackets").push(...MSC_ROWS);
  seed();
  ({ GET, POST } = await import("@/app/api/accountant/payroll/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});

afterEach(() => vi.useRealTimers());

describe("the ₱18,500 employee on the screen, October 16-31 (preview)", () => {
  it("contributions and tax are two groups, every line tagged and explained from the engine's figures", async () => {
    await processFirstHalf();
    const { summary, groups } = await preview("u-mid");
    expect(summary).toMatchObject({ sss: 925, philhealth: 462.5, pagibig: 200, tax: 0 });

    expect(groups.groups.map((g) => g.title)).toEqual([
      "Additions", "Government contributions (employee share)", "Withholding tax (income tax)", "Attendance deductions", "Loans / advances",
    ]);
    expect(lineIn(groups, "contributions", "sss")).toMatchObject({ tag: "percentage", sign: "-", how: "SSS: 5% of ₱18,500.00 (monthly salary credit) = ₱925.00" });
    expect(lineIn(groups, "contributions", "philhealth")).toMatchObject({ tag: "percentage", how: "PhilHealth: 2.5% of ₱18,500.00 (monthly basic salary) = ₱462.50" });
    expect(lineIn(groups, "contributions", "pagibig")).toMatchObject({ tag: "percentage", how: "Pag-IBIG: 2% of ₱10,000.00, capped at ₱200.00 = ₱200.00" });
    expect(groups.groups[1].subtotal).toBe(1587.5);

    // Taxable income between the groups: 18,500 − 1,587.50.
    expect(groups.taxable.amount).toBe(16912.5);
    const tax = lineIn(groups, "tax", "withholding_tax");
    expect(tax).toMatchObject({ tag: "bracket", amount: 0, sign: "0" });
    expect(tax.how).toBe("Taxable income ₱16,912.50 is in the exempt bracket (up to ₱20,833 a month), so no tax is withheld.");
    expect(groups.tax).toMatchObject({ index: 0, range: "up to ₱20,833", tax: 0 });

    // The 2nd half shows its own half (2026-11-14): no "Paid in 1st half" settlement line.
    expect(lineIn(groups, "additions", "basic")).toMatchObject({ tag: "fixed", sign: "+", label: "Basic salary (2nd half)", amount: 9250 });
    expect(groups.reconciliation).toMatchObject({ first_half_net: 9250, total: summary.monthNet, monthly_net: summary.monthNet });
    // Every line has a known tag and a text; the lines add up to the net shown.
    allLines(groups).forEach((l) => { expect(LINE_TAGS[l.tag]).toBeTruthy(); expect(l.how).toBeTruthy(); });
    expect(linesNet(groups)).toBe(summary.net);
    expect(summary.net).toBe(9250 - 1587.5);
  });
});

describe("a taxable bracket, the SSS ceiling, the PhilHealth floor, the Pag-IBIG cap", () => {
  it("₱45,000: bracket ₱33,333 to ₱66,666 highlighted, base, rate and excess match a hand calculation", async () => {
    await processFirstHalf();
    const { summary, groups } = await preview("u-high");
    expect(summary).toMatchObject({ sss: 1750, philhealth: 1125, pagibig: 200, tax: 3593.4 });
    expect(lineIn(groups, "contributions", "sss").how).toBe("SSS: 5% of ₱35,000.00 (monthly salary credit, the SSS ceiling) = ₱1,750.00");
    expect(groups.taxable.amount).toBe(41925);
    expect(groups.tax).toMatchObject({ index: 2, range: "₱33,333 to ₱66,666", base_tax: 1875, rate_pct: 20, excess: 8592, tax: 3593.4, matches: true });
    expect(groups.tax.effective_pct).toBe(8.57);
    expect(groups.tax.formula_text).toBe("₱1,875.00 + 20% × (₱41,925.00 − ₱33,333.00) = ₱3,593.40");
    expect(lineIn(groups, "tax", "withholding_tax").how).toBe("₱1,875.00 + 20% of the excess over ₱33,333 (bracket ₱33,333 to ₱66,666) = ₱3,593.40; 8.57% of taxable income");
  });

  it("₱8,000: PhilHealth on the floor, Pag-IBIG under its cap, all stated", async () => {
    await processFirstHalf();
    const { groups } = await preview("u-low");
    expect(lineIn(groups, "contributions", "philhealth").how).toBe("PhilHealth: 2.5% of ₱10,000.00 (the PhilHealth floor; salary is below it) = ₱250.00");
    expect(lineIn(groups, "contributions", "pagibig").how).toBe("Pag-IBIG: 2% of ₱8,000.00 (monthly basic salary) = ₱160.00");
    expect(lineIn(groups, "contributions", "sss").how).toBe("SSS: 5% of ₱8,000.00 (monthly salary credit) = ₱400.00");
  });

  it("a Super Admin rate change (a copy in the test database) changes the label with the amount", async () => {
    table("payroll_rate_configs").push(rate("sss_pct", 6, "2026-10-16", "2026-10-20T00:00:00Z"));
    await processFirstHalf();
    const { summary, groups } = await preview("u-mid");
    expect(summary.sss).toBe(1110);
    expect(lineIn(groups, "contributions", "sss").how).toBe("SSS: 6% of ₱18,500.00 (monthly salary credit) = ₱1,110.00");
  });
});

describe("the stored payslip (payslip and HR view): same groups, from its own figures", () => {
  beforeEach(async () => {
    await processFirstHalf();
    const body = await (await POST(request("/api/accountant/payroll", "POST", { action: "batch_submit", pay_period: SECOND, entries: PEOPLE.map((p) => ({ employee_id: p.id })) }))).json();
    expect(body.processed).toHaveLength(PEOPLE.length);
  });

  it("2nd half: tagged groups that add up to the payslip's own gross, deductions and net", () => {
    const payroll = entry("u-high", SECOND).payroll;
    const groups = payrollLineGroups(payroll, { taxTable: BIR_MONTHLY.map(([over, base, pct]) => ({ over, base, rate: pct / 100 })) });
    expect(groups).not.toBeNull();
    expect(groups.gross).toBe(payroll.monthly.cutoff.gross_pay);
    expect(groups.total_deductions).toBe(payroll.monthly.cutoff.total_deductions);
    expect(groups.net).toBe(payroll.totals.net_pay);
    expect(lineIn(groups, "contributions", "sss")).toMatchObject({ amount: 1750, tag: "percentage" });
    expect(lineIn(groups, "contributions", "sss").how).toContain("the SSS ceiling");
    expect(lineIn(groups, "tax", "withholding_tax")).toMatchObject({ amount: 3593.4, tag: "bracket" });
    expect(groups.tax.range).toBe("₱33,333 to ₱66,666");
    expect(groups.taxable.amount).toBe(41925);
    allLines(groups).forEach((l) => expect(LINE_TAGS[l.tag]).toBeTruthy());
  });

  it("the payslip never carries the employer's shares or EC", () => {
    const details = buildPayslipDetails(entry("u-mid", SECOND));
    const text = JSON.stringify(details.line_groups);
    expect(details.line_groups).not.toBeNull();
    // Employer: SSS 10% × 18,500 = 1,850, EC ₱30, PhilHealth 462.50 (same as the employee's), Pag-IBIG 200.
    expect(text).not.toMatch(/employer|"EC"|1,850|1850/i);
    expect(details.line_groups.groups.find((g) => g.key === "contributions").lines.map((l) => l.key)).toEqual(["sss", "philhealth", "pagibig"]);
  });

  it("1st half: contributions and tax say they are deducted on the 2nd half", () => {
    const groups = payrollLineGroups(entry("u-mid", FIRST).payroll);
    expect(groups).not.toBeNull();
    const contributions = groups.groups.find((g) => g.key === "contributions");
    expect(contributions).toMatchObject({ note: DEFERRED_NOTE, lines: [] });
    expect(groups.groups.find((g) => g.key === "tax")).toMatchObject({ note: DEFERRED_NOTE, lines: [] });
    expect(groups.taxable).toBeNull();
    expect(groups.net).toBe(9250);
  });

  it("a payslip without the per-cutoff breakdown keeps its old layout (no labels invented)", () => {
    const payroll = JSON.parse(JSON.stringify(entry("u-mid", SECOND).payroll));
    delete payroll.monthly.cutoff;
    expect(payrollLineGroups(payroll)).toBeNull();
    // Lines that would not add up to the stored totals are not shown either.
    const broken = JSON.parse(JSON.stringify(entry("u-mid", SECOND).payroll));
    broken.monthly.cutoff.total_deductions += 100;
    expect(payrollLineGroups(broken)).toBeNull();
  });
});

describe("rate × units, fixed and not charged lines; overrides marked", () => {
  it("absence, undertime, late at 0%, a loan, and an override reason", () => {
    const result = buildLineGroups({
      half: "second",
      additions: { basic: { label: "Basic pay", amount: 9250, how: "Monthly salary ₱18,500.00 ÷ 2 = ₱9,250.00" } },
      contributions: {},
      attendance: {
        absent: { amount: 850.57, days: 1, unit: 850.57 },
        late: { amount: 0, days: 2, minutes: 25, per_absent: 0, minute_pct: 0 },
        undertime: { amount: 53.16, minutes: 30, hourly: 106.32 },
      },
      loans: [{ kind: "cash_advance", label: "Cash advance", amount: 500, how: "Installment ₱500.00; balance ₱1,500.00 → ₱1,000.00" }],
      overrides: { absent: { reason: "RFID reader down", from: 0, to: 1 } },
    });
    expect(lineIn(result, "attendance", "absent")).toMatchObject({ tag: "rate_units", how: "1 day × ₱850.57/day = ₱850.57", overridden: { reason: "RFID reader down" } });
    expect(lineIn(result, "attendance", "undertime")).toMatchObject({ tag: "rate_units", how: "30 minutes × ₱106.32/hour ÷ 60 = ₱53.16" });
    expect(lineIn(result, "attendance", "late")).toMatchObject({ tag: "not_charged", amount: 0, sign: "0" });
    expect(lineIn(result, "loans", "cash_advance-0")).toMatchObject({ tag: "fixed", sign: "-" });
  });

  it("a ₱0 tax with no taxable income says why", () => {
    expect(taxExplanation({ taxable: 0, tax: 0, table: BIR_MONTHLY.map(([over, base, pct]) => ({ over, base, rate: pct / 100 })) }).reason)
      .toBe("No taxable income this month after the government contributions.");
  });
});
