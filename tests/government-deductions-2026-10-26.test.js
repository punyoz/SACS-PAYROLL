/**
 * Government deductions as percentages (2026-10-26): SSS 5% of the salary
 * credit from the SSS table, PhilHealth 2.5% of basic within ₱10,000–₱100,000,
 * Pag-IBIG 2% of basic up to ₱10,000, withholding tax once a month on the 2nd
 * half from the BIR monthly table (decision 2026-10-26: tax stays monthly).
 * Every figure below was worked out by hand first; the comments show how.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import {
  contributionLabel,
  monthlyContributions,
  sssMonthlySalaryCredit,
  withholdingTax,
  withholdingTaxLabel,
} from "@/lib/payroll/statutory";
import { monthlyWithholdingTax, withholdingTaxBracket } from "@/lib/payroll/semi-monthly";
import { mscTableFromRows, mscTableOn, validateMscRows } from "@/lib/payroll/sss-msc";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

// The SSS schedule from January 2025, exactly as 20261026020000 seeds it.
const MSC_2025_ROWS = [
  { salary_from: 0, msc: 5000 },
  ...Array.from({ length: 60 }, (_, i) => ({ salary_from: 4750 + 500 * (i + 1), msc: 5000 + 500 * (i + 1) })),
].map((row) => ({ ...row, id: `msc-${row.salary_from}`, version_id: "msc-2025", effective_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" }));
const MSC_2025 = mscTableFromRows(MSC_2025_ROWS);

// Live legal rates (payroll_rate_configs, effective Oct 1, 2026).
const LEGAL = {
  sss_pct: 5, philhealth_pct: 2.5, pagibig_pct: 2, sss_msc_min: 5000, sss_msc_max: 35000,
  philhealth_floor: 10000, philhealth_ceiling: 100000, pagibig_max_salary: 10000,
};
// BIR monthly table (RR 11-2018 Annex E, 2023 onward), as stored live.
const BIR_MONTHLY = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const MONTHLY_TABLE = BIR_MONTHLY.map(([over, base, pct]) => ({ over, base, rate: pct / 100 }));

describe("the SSS salary credit table", () => {
  it("has 61 brackets, ₱5,000 to ₱35,000, and passes its own checks", () => {
    expect(MSC_2025).toHaveLength(61);
    expect([MSC_2025[0], MSC_2025[1], MSC_2025[60]]).toEqual([{ from: 0, msc: 5000 }, { from: 5250, msc: 5500 }, { from: 34750, msc: 35000 }]);
    expect(validateMscRows(MSC_2025_ROWS)).toBeNull();
  });

  it("puts each salary in the right bracket, edges included", () => {
    const msc = (salary) => sssMonthlySalaryCredit(salary, LEGAL, MSC_2025);
    expect([msc(0), msc(5249.99), msc(5250), msc(5749.99), msc(5750)]).toEqual([5000, 5000, 5500, 5500, 6000]);
    expect([msc(18000), msc(18249.99), msc(18250)]).toEqual([18000, 18000, 18500]);
    expect([msc(34749.99), msc(34750), msc(120000)]).toEqual([34500, 35000, 35000]);
  });

  it("gives the same credit as the ₱500-step formula it replaces, for every salary to ₱40,000", () => {
    for (let salary = 0; salary <= 40000; salary += 12.5) {
      expect(sssMonthlySalaryCredit(salary, LEGAL, MSC_2025), String(salary)).toBe(sssMonthlySalaryCredit(salary, LEGAL));
    }
  });

  it("uses the version in force on the period's first day", () => {
    const next = [{ id: "n0", version_id: "v2027", effective_date: "2027-01-01", salary_from: 0, msc: 5500, created_at: "2026-12-01T00:00:00Z" }];
    expect(mscTableOn([...MSC_2025_ROWS, ...next], "2026-12-16")[0].msc).toBe(5000);
    expect(mscTableOn([...MSC_2025_ROWS, ...next], "2027-01-01")[0].msc).toBe(5500);
    expect(mscTableOn([], "2026-11-01")).toBeNull();
  });

  it("refuses a malformed table", () => {
    expect(validateMscRows([])).toMatch(/at least one/);
    expect(validateMscRows([{ salary_from: 100, msc: 5000 }])).toMatch(/start at a salary of 0/);
    expect(validateMscRows([{ salary_from: 0, msc: 5000 }, { salary_from: 0, msc: 5500 }])).toMatch(/above the one before/);
    expect(validateMscRows([{ salary_from: 0, msc: 5000 }, { salary_from: 5250, msc: 4000 }])).toMatch(/lower salary credit/);
    expect(validateMscRows([{ salary_from: 0, msc: 0 }])).toMatch(/more than 0/);
  });
});

describe("monthly contributions, worked by hand", () => {
  const contributions = (salary) => monthlyContributions(salary, LEGAL, { mscTable: MSC_2025 });

  it("₱18,000: SSS 5% × 18,000 = 900; PhilHealth 2.5% × 18,000 = 450; Pag-IBIG 2% × 10,000 cap = 200", () => {
    const c = contributions(18000);
    expect(c).toMatchObject({ sss: 900, philhealth: 450, pagibig: 200, sss_msc: 18000 });
    expect(c.basis).toEqual({
      sss: { pct: 5, base: 18000, base_label: "salary credit" },
      philhealth: { pct: 2.5, base: 18000, base_label: "basic" },
      pagibig: { pct: 2, base: 10000, base_label: "fund salary cap" },
    });
    expect(contributionLabel("SSS", c.basis.sss)).toBe("SSS (5% of ₱18,000 salary credit)");
    expect(contributionLabel("PhilHealth", c.basis.philhealth)).toBe("PhilHealth (2.5% of ₱18,000 basic)");
    expect(contributionLabel("Pag-IBIG", c.basis.pagibig)).toBe("Pag-IBIG (2% of ₱10,000 fund salary cap)");
  });

  it("₱8,000 (below the PhilHealth floor): PhilHealth on the ₱10,000 floor = 250; SSS 400; Pag-IBIG 2% × 8,000 = 160", () => {
    const c = contributions(8000);
    expect(c).toMatchObject({ sss: 400, philhealth: 250, pagibig: 160 });
    expect(contributionLabel("PhilHealth", c.basis.philhealth)).toBe("PhilHealth (2.5% of ₱10,000 floor)");
  });

  it("₱120,000 (above every ceiling): SSS 5% × 35,000 = 1,750; PhilHealth 2.5% × 100,000 = 2,500; Pag-IBIG 200", () => {
    const c = contributions(120000);
    expect(c).toMatchObject({ sss: 1750, philhealth: 2500, pagibig: 200, sss_msc: 35000 });
    expect(contributionLabel("PhilHealth", c.basis.philhealth)).toBe("PhilHealth (2.5% of ₱100,000 ceiling)");
    // Higher still changes nothing.
    expect(contributions(500000)).toMatchObject({ sss: 1750, philhealth: 2500, pagibig: 200 });
  });

  it("a fixed or employee amount has no rate to show", () => {
    expect(contributionLabel("SSS", null)).toBe("SSS");
    expect(contributionLabel("SSS", undefined)).toBe("SSS");
  });
});

describe("withholding tax brackets, at the boundaries", () => {
  it("monthly table (what payroll uses): ₱20,833 is exempt, ₱20,834 is in the 15% bracket", () => {
    expect(monthlyWithholdingTax(20833, MONTHLY_TABLE)).toBe(0);
    expect(withholdingTaxBracket(20833, MONTHLY_TABLE)).toMatchObject({ over: 0, rate_pct: 0 });
    expect(monthlyWithholdingTax(20834, MONTHLY_TABLE)).toBe(0.15);
    expect(withholdingTaxBracket(20834, MONTHLY_TABLE)).toMatchObject({ over: 20833, rate_pct: 15 });
    // 33,333: still 15% bracket, (33,333 − 20,833) × 15% = 1,875; above it 1,875 + 20%.
    expect(monthlyWithholdingTax(33333, MONTHLY_TABLE)).toBe(1875);
    expect(monthlyWithholdingTax(33334, MONTHLY_TABLE)).toBe(1875.2);
    expect(withholdingTaxLabel("Withholding tax", withholdingTaxBracket(16450, MONTHLY_TABLE))).toBe("Withholding tax (exempt bracket)");
    expect(withholdingTaxLabel("Withholding tax", withholdingTaxBracket(29900, MONTHLY_TABLE))).toBe("Withholding tax (15% over ₱20,833)");
    expect(withholdingTaxLabel("Withholding tax", withholdingTaxBracket(46295, MONTHLY_TABLE))).toBe("Withholding tax (₱1,875 + 20% over ₱33,333)");
  });

  it("semi-monthly table (kept for reference): ₱10,417 is exempt, ₱10,418 is 15%", () => {
    expect(withholdingTax(10417)).toBe(0);
    expect(withholdingTax(10418)).toBe(0.15);
    expect(withholdingTax(16667)).toBe(937.5);
    expect(withholdingTax(16668)).toBe(937.7);
  });

  it("no civil status, dependents or exemption anywhere in the tax computation", () => {
    const sources = ["src/lib/payroll/statutory.js", "src/lib/payroll/semi-monthly.js", "src/lib/payroll/bir-2316.js", "src/app/api/accountant/payroll/route.js"]
      .map((file) => readFileSync(file, "utf8"));
    sources.forEach((source) => expect(source).not.toMatch(/civil_status|marital|dependents|single parent|head of family/i));
  });
});

/* ── Through the Accountant's payroll route: November 2026 ───────────────── */

describe("November 2026 payroll with percentage contributions", () => {
  const BRANCH = "branch-main";
  const FIRST = "November 1-15, 2026";
  const SECOND = "November 16-30, 2026";
  const PEOPLE = [
    { id: "u-ana", name: "Ana Eighteen", code: "SACS-201", salary: 18000 },
    { id: "u-ben", name: "Ben Eight", code: "SACS-202", salary: 8000 },
    { id: "u-cy", name: "Cy Onetwenty", code: "SACS-203", salary: 120000 },
  ];
  const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
    id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
  });
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;
  const request = (body) => new Request("https://sacs.test/api/accountant/payroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: "u-acct", role: "accountant", branch_id: BRANCH, email: "acct@sacs.test", full_name: "Pay Accountant", session_id: "s-1" })}`,
    },
    body: JSON.stringify(body),
  });
  const entry = (id, label) => table("payroll_entries").find((e) => e.employee_id === id && e.pay_period === label);
  const ids = PEOPLE.map((p) => ({ employee_id: p.id }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T10:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-government-deductions";
    resetDb();
    table("profiles").push({ id: "u-acct", branch_id: BRANCH });
    PEOPLE.forEach((p) => {
      users.push({ id: p.id, email: `${p.code}@sacs.test`, user_metadata: { role: "employee", full_name: p.name, employee_id: p.code, basic_salary: p.salary, branch_id: BRANCH } });
      table("profiles").push({ id: p.id, full_name: p.name, email: `${p.code}@sacs.test`, branch_id: BRANCH, role: "employee", employee_id: p.code, archived: false, basic_salary: p.salary, date_hired: "2024-06-01" });
    });
    table("payroll_rate_configs").push(
      rate("daily", 600, "2026-10-01"), rate("half_day_pct", 50), rate("absent_pct", 100), rate("late_days_per_absent", 0, "2026-10-01"),
      rate("late_minute_charge_pct", 0), rate("perfect_attendance_bonus", 0), rate("working_days_per_year", 261, "2026-10-01"),
      rate("attendance_lock_day", 0, "2026-10-01"), rate("carry_after_lock", 1, "2026-10-01"), rate("payroll_per_half", 0, "2026-10-01"),
      rate("contribution_half", 2, "2026-10-01"),
      ...Object.entries(LEGAL).map(([type, value]) => rate(type, value, "2026-10-01")),
      // Live: fixed amounts in October; this change's migration switches to the legal rates from Nov 1.
      rate("contribution_method", 1, "2026-10-01"), rate("contribution_method", 0, "2026-11-01"),
      rate("sss_fixed", 300, "2026-10-16"), rate("philhealth_fixed", 400, "2026-10-16"), rate("pagibig_fixed", 400, "2026-10-16"),
    );
    table("payroll_tax_brackets").push(...BIR_MONTHLY.map(([over, base, pct]) => ({
      id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z",
    })));
    table("payroll_sss_msc_brackets").push(...MSC_2025_ROWS);

    ({ POST } = await import("@/app/api/accountant/payroll/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
    expect((await (await POST(request({ action: "batch_submit", pay_period: FIRST, entries: ids }))).json()).processed).toHaveLength(3);
    vi.setSystemTime(new Date("2026-12-02T10:00:00+08:00"));
    expect((await (await POST(request({ action: "batch_submit", pay_period: SECOND, entries: ids }))).json()).processed).toHaveLength(3);
  });

  afterEach(() => vi.useRealTimers());

  it("₱18,000: 900 / 450 / 200 on the 16-end payslip, no tax (taxable 16,450 ≤ 20,833), halves sum to 18,000 − 1,550", () => {
    const first = entry("u-ana", FIRST).payroll;
    const second = entry("u-ana", SECOND).payroll;
    expect(first.deductions).toMatchObject({ sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0 });
    expect(second.deductions).toMatchObject({ sss: 900, philhealth: 450, pagibig: 200, withholding_tax: 0 });
    expect(second.monthly).toMatchObject({ contributions: 1550, taxable_income: 16450, withholding_tax: 0, tax_bracket: { over: 0, base: 0, rate_pct: 0 } });
    expect(first.totals.net_pay + second.totals.net_pay).toBe(18000 - 1550);
    expect(second.monthly.cutoff.deductions.map((l) => [l.label, l.amount])).toEqual([
      ["SSS (5% of ₱18,000 salary credit)", 900], ["PhilHealth (2.5% of ₱18,000 basic)", 450], ["Pag-IBIG (2% of ₱10,000 fund salary cap)", 200],
    ]);
  });

  it("₱8,000: PhilHealth on the ₱10,000 floor", () => {
    const second = entry("u-ben", SECOND).payroll;
    expect(second.deductions).toMatchObject({ sss: 400, philhealth: 250, pagibig: 160, withholding_tax: 0 });
    expect(second.monthly.cutoff.deductions.map((l) => l.label)).toContain("PhilHealth (2.5% of ₱10,000 floor)");
  });

  it("₱120,000: capped contributions; tax once on the month — 120,000 − 4,450 = 115,550 → 8,541.80 + 25% × 48,883 = 20,762.55", () => {
    const first = entry("u-cy", FIRST).payroll;
    const second = entry("u-cy", SECOND).payroll;
    expect(first.deductions.withholding_tax).toBe(0);
    expect(second.deductions).toMatchObject({ sss: 1750, philhealth: 2500, pagibig: 200, withholding_tax: 20762.55 });
    expect(second.monthly).toMatchObject({ taxable_income: 115550, tax_bracket: { over: 66667, base: 8541.8, rate_pct: 25 } });
    expect(second.monthly.cutoff.deductions.map((l) => l.label)).toEqual([
      "SSS (5% of ₱35,000 salary credit)", "PhilHealth (2.5% of ₱100,000 ceiling)", "Pag-IBIG (2% of ₱10,000 fund salary cap)",
      "Withholding tax (₱8,541.80 + 25% over ₱66,667)",
    ]);
  });

  it("changing a rate or the SSS table afterwards does not touch the processed payslips", async () => {
    const before = JSON.stringify(PEOPLE.flatMap((p) => [entry(p.id, FIRST), entry(p.id, SECOND)]));
    table("payroll_rate_configs").push(rate("pagibig_max_salary", 20000, "2026-11-16"), rate("philhealth_pct", 3, "2026-11-01"));
    table("payroll_sss_msc_brackets").push({ id: "n0", version_id: "v-new", effective_date: "2026-11-01", salary_from: 0, msc: 20000, created_at: "2026-12-02T00:00:00Z" });
    // Processing again is refused for Final payslips; nothing is rewritten.
    await POST(request({ action: "batch_submit", pay_period: SECOND, entries: ids }));
    expect(JSON.stringify(PEOPLE.flatMap((p) => [entry(p.id, FIRST), entry(p.id, SECOND)]))).toBe(before);
  });
});
