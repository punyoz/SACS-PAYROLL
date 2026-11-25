/**
 * My Payslips (2026-11-15): every payslip in the full layout, from its STORED
 * snapshot, the same lines on screen and in the PDF, only the caller's own
 * and only once Paid. The history is computed by today's rules when the demo
 * build sets PAYROLL_RULES_FROM (src/lib/payroll/statutory.js).
 *
 * Andrea (DEMO-005), ₱24,000 a month, September 2026, no attendance deducted:
 *   1st half  12,000; no SSS / PhilHealth / Pag-IBIG / tax lines
 *   2nd half  SSS 5% × 24,000 = 1,200, PhilHealth 2.5% × 24,000 = 600,
 *             Pag-IBIG 2% × 10,000 (cap) = 200 → 2,000; taxable 22,000;
 *             tax 15% × (22,000 − 20,833) = 175.05; net 12,000 − 2,000 − 175.05 = 9,824.95
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { rulesEffectiveFrom } from "@/lib/payroll/statutory";
import { readPdf } from "./helpers/pdf-read";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const BRANCH = "branch-main";
const FIRST = "September 1-15, 2026";
const SECOND = "September 16-30, 2026";
const PEOPLE = [
  { id: "u-andrea", name: "Andrea Demo Ilagan", code: "DEMO-005", salary: 24000, role: "employee" },
  { id: "u-hr", name: "Demo HR One", code: "DEMO-HR1", salary: 30000, role: "hr" },
  { id: "u-acc2", name: "Demo Accountant Two", code: "DEMO-AC2", salary: 20000, role: "accountant" },
];
// Hired on the 16th (registered with everyone; only her own describe processes her).
const URSULA = { id: "u-ursula", name: "Ursula Demo Tolentino", code: "DEMO-028", salary: 10000, role: "employee" };
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const MSC_ROWS = [{ salary_from: 0, msc: 5000 }, ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) }))]
  .map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
// Today's rates in force for the whole history (as the demo build copies them).
const rate = (rateType, value) => ({ id: `cfg-${rateType}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" });

let ACC_POST;
let ME_GET;
let EMP_GET;
let createSessionToken;
let SESSION_COOKIE;
const ACCOUNTANT = { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Payroll JM" };
const asPerson = (p) => ({ user_id: p.id, role: p.role, branch_id: p.role === "hr" ? null : BRANCH, full_name: p.name });
const request = (url, who, method = "GET", body) => new Request(`https://sacs.test${url}`, {
  method,
  headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${createSessionToken({ session_id: `s-${who.user_id}`, email: `${who.user_id}@sacs.test`, ...who })}` },
  body: body ? JSON.stringify(body) : undefined,
});
const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);

async function processPeriod(label, at) {
  vi.setSystemTime(new Date(at));
  const body = await (await ACC_POST(request("/api/accountant/payroll", ACCOUNTANT, "POST", { action: "batch_submit", pay_period: label, entries: PEOPLE.map((p) => ({ employee_id: p.id })) }))).json();
  expect(body.processed).toHaveLength(PEOPLE.length);
}

/** The run HR decided: every payslip of the period gets it. */
function decide(label, status) {
  const id = `run-${label}`;
  table("payroll_runs").push({ id, status, branch_id: BRANCH, period_label: label });
  table("payroll_entries").filter((e) => e.pay_period === label).forEach((e) => { e.run_id = id; e.approved_at = status === "approved" ? "2026-09-30T07:00:00Z" : null; });
}

const myPayslips = async (person) => (await (await ME_GET(request(`/api/me/payslips?email=${encodeURIComponent(`${PEOPLE[0].id}@sacs.test`)}`, asPerson(person)))).json()).payslips;
const pdfText = async (person, id) => {
  const response = await ME_GET(request(`/api/me/payslips?format=pdf&entry_id=${id}`, asPerson(person)));
  if (response.status !== 200) return { status: response.status, text: "" };
  // Every text run in order, joined (tests/helpers/pdf-read.js): a label wrapped onto two lines reads as one again.
  const { text } = await readPdf(Buffer.from(await response.arrayBuffer()));
  return { status: response.status, text };
};
/** The PDF holds the text as it is (embedded Noto Sans: real ₱ and −); only spacing is normalised. */
const inPdf = (value) => String(value).replace(/\s+/g, " ");
const money = (n) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-my-payslips";
  process.env.PAYROLL_RULES_FROM = "2026-01-01";
  resetDb();
  table("profiles").push({ id: "u-acct", branch_id: BRANCH, role: "accountant", full_name: "Payroll JM" });
  PEOPLE.forEach((p) => {
    users.push({ id: p.id, email: `${p.id}@sacs.test`, user_metadata: { role: p.role, full_name: p.name, employee_id: p.code, basic_salary: p.salary, branch_id: BRANCH } });
    table("profiles").push({ id: p.id, full_name: p.name, email: `${p.id}@sacs.test`, branch_id: BRANCH, role: p.role, employee_id: p.code, archived: false, basic_salary: p.salary, date_hired: "2024-06-01" });
  });
  users.push({ id: URSULA.id, email: `${URSULA.id}@sacs.test`, user_metadata: { role: "employee", full_name: URSULA.name, employee_id: URSULA.code, basic_salary: URSULA.salary, branch_id: BRANCH } });
  table("profiles").push({ id: URSULA.id, full_name: URSULA.name, email: `${URSULA.id}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: URSULA.code, archived: false, basic_salary: URSULA.salary, date_hired: "2026-06-16" });
  table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
    id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
  })));
  table("payroll_sss_msc_brackets").push(...MSC_ROWS);
  table("payroll_rate_configs").push(
    rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0), rate("late_minute_charge_pct", 0),
    rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261), rate("attendance_lock_day", 0), rate("carry_after_lock", 1),
    rate("payroll_per_half", 0), rate("contribution_half", 2), rate("benefits_exempt_ceiling", 90000), rate("contribution_method", 0),
    rate("sss_pct", 5), rate("philhealth_pct", 2.5), rate("pagibig_pct", 2), rate("sss_msc_min", 5000), rate("sss_msc_max", 35000),
    rate("philhealth_floor", 10000), rate("philhealth_ceiling", 100000), rate("pagibig_max_salary", 10000),
    rate("sss_er_pct", 10), rate("philhealth_er_pct", 2.5), rate("pagibig_er_pct", 2), rate("sss_ec_low", 10), rate("sss_ec_high", 30), rate("sss_ec_threshold", 15000),
  );
  ({ POST: ACC_POST } = await import("@/app/api/accountant/payroll/route"));
  ({ GET: ME_GET } = await import("@/app/api/me/payslips/route"));
  ({ GET: EMP_GET } = await import("@/app/api/employee/payslips/route"));
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  await processPeriod(FIRST, "2026-09-16T10:00:00+08:00");
  await processPeriod(SECOND, "2026-10-01T10:00:00+08:00");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PAYROLL_RULES_FROM;
  delete process.env.VERCEL;
});

describe("the rule start date (demo builds only)", () => {
  it("moves earlier only when set, valid and not on Vercel", () => {
    expect(rulesEffectiveFrom("2026-10-01")).toBe("2026-01-01");
    process.env.PAYROLL_RULES_FROM = "2027-01-01";
    expect(rulesEffectiveFrom("2026-10-01")).toBe("2026-10-01");
    process.env.PAYROLL_RULES_FROM = "soon";
    expect(rulesEffectiveFrom("2026-10-01")).toBe("2026-10-01");
    process.env.PAYROLL_RULES_FROM = "2026-01-01";
    process.env.VERCEL = "1";
    expect(rulesEffectiveFrom("2026-10-01")).toBe("2026-10-01");
  });

  it("September computed by today's engine: 1st half attendance only, the month settled on the 2nd half", () => {
    const first = entry("u-andrea", FIRST).payroll;
    const second = entry("u-andrea", SECOND).payroll;
    expect(first.monthly.cutoff.half).toBe("first");
    expect(first.deductions).toMatchObject({ sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0 });
    expect(second.deductions).toMatchObject({ sss: 1200, philhealth: 600, pagibig: 200, withholding_tax: 175.05 });
    expect(second.monthly.taxable_income).toBe(22000);
    expect(second.totals.net_pay).toBe(9824.95);
  });

  it("every month reconciles: 1st-half net + 2nd-half net = the month's net", () => {
    PEOPLE.forEach((p) => {
      const first = entry(p.id, FIRST).payroll.totals.net_pay;
      const m = entry(p.id, SECOND).payroll.monthly;
      expect(m.first_half_paid).toBe(first);
      expect(Math.round((first + entry(p.id, SECOND).payroll.totals.net_pay) * 100) / 100).toBe(m.monthly_net);
    });
  });
});

describe("My Payslips: full layout from the stored snapshot, for every role on payroll", () => {
  beforeEach(() => { decide(FIRST, "approved"); decide(SECOND, "approved"); });

  it.each(PEOPLE)("$role: only their own, 1st half without contributions or tax, 2nd half with them", async (person) => {
    const list = await myPayslips(person);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual([entry(person.id, FIRST).id, entry(person.id, SECOND).id].sort());
    const first = list.find((p) => p.period_label === FIRST).line_groups;
    const second = list.find((p) => p.period_label === SECOND).line_groups;
    expect(first).not.toBeNull();
    expect(first.groups.map((g) => g.key)).toEqual(["additions"]);
    expect(first.groups[0].lines[0]).toMatchObject({ key: "basic", label: "Basic pay (1st cutoff)", amount: person.salary / 2 });
    expect(first.groups[0].lines[0].how).toBe(`Monthly salary ₱${money(person.salary)} ÷ 2 = ₱${money(person.salary / 2)}`);
    expect(first.first_half_note).toBe("Government contributions and withholding tax are deducted on the 2nd-half payslip");
    expect(first.tax_box).toBeNull();
    expect(first.month_total).toBeNull();
    expect(second.groups.map((g) => g.key)).toContain("contributions");
    expect(second.first_half_note).toBeNull();
    expect(second.month_total.total).toBe(entry(person.id, SECOND).payroll.monthly.monthly_net);
    // Never an Accountant-only item, never a ₱0 line.
    const lines = [...first.groups, ...second.groups].flatMap((g) => g.lines);
    lines.forEach((l) => { expect(l.amount).toBeGreaterThan(0); expect(l.overridden).toBeUndefined(); });
    expect(JSON.stringify(list)).not.toMatch(/flags|override_reason|employer/i);
  });

  it("Andrea's 2nd half: the contributions with their formulas and the month's tax computation", async () => {
    const view = (await myPayslips(PEOPLE[0])).find((p) => p.period_label === SECOND).line_groups;
    const contributions = view.groups.find((g) => g.key === "contributions").lines;
    expect(contributions.map((l) => [l.key, l.amount])).toEqual([["sss", 1200], ["philhealth", 600], ["pagibig", 200]]);
    expect(contributions[0].how).toContain("5% of ₱24,000.00");
    expect(view.groups.find((g) => g.key === "tax").lines[0]).toMatchObject({ key: "withholding_tax", amount: 175.05 });
    expect(view.tax_box.rows).toEqual([
      { label: "Monthly basic salary", amount: 24000, sign: "" },
      { label: "SSS, PhilHealth and Pag-IBIG", amount: 2000, sign: "-" },
    ]);
    expect(view.tax_box).toMatchObject({ taxable: 22000, tax: 175.05, bracket: "₱20,833 to ₱33,332" });
    expect(view.tax_box.formula).toBe("₱0.00 + 15% × (₱22,000.00 − ₱20,833.00) = ₱175.05");
    expect(view.net).toBe(9824.95);
    expect(view.month_total.label).toBe("Month total: 1st half ₱12,000.00 + 2nd half ₱9,824.95 = ₱21,824.95");
  });

  it("Issued is the day HR approved the run", async () => {
    const list = await myPayslips(PEOPLE[0]);
    list.forEach((p) => expect(p.processed_at).toBe("2026-09-30T07:00:00Z"));
  });

  it.each([FIRST, SECOND])("the PDF prints the same lines and numbers as the screen (%s)", async (label) => {
    const shown = (await myPayslips(PEOPLE[0])).find((p) => p.period_label === label);
    const { status, text } = await pdfText(PEOPLE[0], shown.id);
    expect(status).toBe(200);
    const v = shown.line_groups;
    // One layout for every role (2026-11-18): the screen's tables (payslipTables).
    const { payslipTables } = await import("@/lib/payroll/payslip-tables");
    const t = payslipTables(shown);
    const expected = [
      "Earnings", "Deductions",
      ...[...t.earnings, ...t.incentives, ...t.deductions].flatMap((r) => [r.label, r.text || money(r.amount)]),
      ...t.notes,
      ...(v.tax_box ? [...v.tax_box.rows.flatMap((r) => [r.label, money(r.amount)]), "Taxable income", money(v.tax_box.taxable), v.tax_box.formula, money(v.tax_box.tax)] : []),
      ...(v.month_total ? [v.month_total.label] : []),
      v.net_label.toUpperCase(), money(v.gross), money(v.total_deductions), money(shown.net_pay),
    ];
    expected.forEach((piece) => expect(text, piece).toContain(inPdf(piece)));
    expect(text).not.toContain("?");
    // A 1st half has no contribution or tax rows (2026-11-19): the note says it once.
    if (label === FIRST) {
      expect(t.deductions.filter((r) => ["sss", "philhealth", "pagibig", "withholding_tax"].includes(r.key))).toEqual([]);
      expect(t.notes.filter((n) => /2nd-half payslip/.test(n))).toHaveLength(1);
    }
  });
});

describe("the employee's payslip header matches HR's (2026-11-25)", () => {
  beforeEach(() => { decide(FIRST, "approved"); decide(SECOND, "approved"); });
  it("Category shows the stored category and status (Teaching · Regular), not N/A, the same as HR's payslip", async () => {
    const { buildPayslipDetails } = await import("@/lib/payroll/payslip-details");
    const row = entry(PEOPLE[0].id, FIRST);
    row.payroll = { ...row.payroll, payslip_meta: { ...(row.payroll.payslip_meta || {}), classification: { employee_type: "Teaching", employment_status: "Regular" } } };
    const mine = (await myPayslips(PEOPLE[0])).find((p) => p.period_label === FIRST);
    expect(mine.employee.type).toBe("Teaching · Regular");
    expect(mine.employee.type).toBe(buildPayslipDetails(row).employee.type);
  });
});

describe("visibility and ownership, enforced on the server", () => {
  it("Pending, Rejected and not-submitted payslips are not shown, nor downloadable", async () => {
    expect(await myPayslips(PEOPLE[0])).toEqual([]);
    decide(FIRST, "pending");
    decide(SECOND, "rejected");
    expect(await myPayslips(PEOPLE[0])).toEqual([]);
    expect((await pdfText(PEOPLE[0], entry("u-andrea", FIRST).id)).status).toBe(404);
  });

  it("another person's payslip id is refused, whatever the role", async () => {
    decide(FIRST, "approved");
    const andreas = entry("u-andrea", FIRST).id;
    for (const person of PEOPLE.slice(1)) {
      expect((await pdfText(person, andreas)).status).toBe(404);
      // ?email= cannot widen My Payslips.
      expect((await myPayslips(person)).map((p) => p.id)).not.toContain(andreas);
    }
    // The wider route refuses a PDF of someone else's payslip.
    const hr = asPerson(PEOPLE[1]);
    const response = await EMP_GET(request(`/api/employee/payslips?email=${encodeURIComponent("u-andrea@sacs.test")}&format=pdf&entry_id=${andreas}`, hr));
    expect(response.status).toBe(403);
  });

  it.each(["admin", "super_admin"])("%s: the own-payslip API answers 403", async (role) => {
    const response = await ME_GET(request("/api/me/payslips", { user_id: `u-${role}`, role, branch_id: role === "admin" ? BRANCH : null, full_name: role }));
    expect(response.status).toBe(403);
  });
});

describe("a hire on the 16th: the first month settled on the 2nd half alone", () => {
  // Ursula Demo Tolentino (DEMO-028): ₱10,000 a month, hired Tuesday June 16, 2026.
  //   Paid from the hire date: 11 working days × ₱459.77 (10,000 × 12 ÷ 261) = ₱5,057.47
  //   SSS 5% × 10,000 = 500, PhilHealth 2.5% × 10,000 (floor) = 250, Pag-IBIG 2% × 10,000 = 200 → 950
  //   Taxable = 5,057.47 − 950 = 4,107.47 (the EARNED basic, not ₱10,000) → exempt, tax 0
  //   Net = 5,057.47 − 950 = 4,107.47
  beforeEach(async () => {
    vi.setSystemTime(new Date("2026-07-01T10:00:00+08:00"));
    const body = await (await ACC_POST(request("/api/accountant/payroll", ACCOUNTANT, "POST", { action: "batch_submit", pay_period: "June 16-30, 2026", entries: [{ employee_id: URSULA.id }] }))).json();
    expect(body.processed).toHaveLength(1);
    decide("June 16-30, 2026", "approved");
  });

  it("is taxed on what was earned and says there is no 1st-half payslip", async () => {
    const m = entry(URSULA.id, "June 16-30, 2026").payroll.monthly;
    expect(m.new_hire).toMatchObject({ days: 11, daily_rate: 459.77, amount: 5057.47 });
    expect(m.monthly_salary).toBe(5057.47);
    expect(m.taxable_income).toBe(4107.47);
    expect(m.withholding_tax).toBe(0);

    const shown = (await myPayslips(URSULA)).find((p) => p.period_label === "June 16-30, 2026");
    const v = shown.line_groups;
    expect(v).not.toBeNull();
    expect(v.hire_note).toBe("No 1st-half payslip: hired Jun 16, 2026");
    expect(v.groups[0].lines[0]).toMatchObject({ label: "Basic pay (from the hire date)", amount: 5057.47 });
    expect(v.groups.find((g) => g.key === "contributions").lines.map((l) => l.amount)).toEqual([500, 250, 200]);
    expect(v.tax_box.rows[0]).toEqual({ label: "Basic pay earned (hired Jun 16, 2026)", amount: 5057.47, sign: "" });
    expect(v.tax_box).toMatchObject({ taxable: 4107.47, tax: 0 });
    expect(v.net).toBe(4107.47);
    const { text } = await pdfText(URSULA, shown.id);
    expect(text).toContain("No 1st-half payslip: hired Jun 16, 2026");
  });
});

describe("a batch never skips anyone silently", () => {
  it("every requested employee comes back processed or skipped with a reason", async () => {
    vi.setSystemTime(new Date("2026-10-16T10:00:00+08:00"));
    const ids = [...PEOPLE.map((p) => p.id), "u-nobody", PEOPLE[0].id];
    const body = await (await ACC_POST(request("/api/accountant/payroll", ACCOUNTANT, "POST", { action: "batch_submit", pay_period: "October 1-15, 2026", entries: ids.map((employee_id) => ({ employee_id })) }))).json();
    const answered = new Set([...body.processed, ...body.skipped].map((r) => r.employee_id));
    ids.forEach((id) => expect(answered.has(id), id).toBe(true));
    body.skipped.forEach((s) => expect(String(s.reason || "").length).toBeGreaterThan(0));
    expect(body.skipped.find((s) => s.employee_id === "u-nobody").reason).toBe("Employee not found.");
  });
});
