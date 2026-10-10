/**
 * Licensed Teacher Annual Subsidy (docs/payroll-schedule-loans-awol.md §6):
 * src/lib/payroll/teacher-subsidy.js, the payout on the 2nd-half payslip
 * (worked example 7.4) and /api/hr/teacher-license. Eligibility months, the
 * advance cap and the license triggers are tested against PostgreSQL with
 * 20261009010000.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { subsidyForPayslip } from "@/lib/payroll/teacher-subsidy";
import { licenseStatus, validateLicenseChange } from "@/lib/employees/teacher-license";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const DEC = { start_key: "2027-12-16", end_key: "2027-12-31", label: "December 16-31, 2027" };
const balance = (fields = {}) => ({
  id: "bal", subsidy_year_start: "2027-01-01", payout_period_start: "2027-12-16", status: "open", annual_amount: 24000,
  entitlement: 24000, eligible_months: 12, advances_total: 10000, carried_in: 0, paid_out: 0, forfeited: 0, tax_treatment: "other_benefit", ...fields,
});

describe("Subsidy on the payslip", () => {
  it("payout = entitlement − advances; the advance is closed by an offset (never from salary)", () => {
    const s = subsidyForPayslip({ balance: balance(), advances: [{ id: "adv", remaining_balance: 10000, status: "active" }], benefits_ytd: 35000 }, DEC, 90000);
    expect(s.payout).toBe(14000);
    expect(s.loan_payments).toEqual([{ loan_id: "adv", kind: "subsidy_offset", amount: 10000, amount_due: 10000 }]);
    expect(s.settlement).toEqual({ balance_id: "bal", payout: 14000, paid_on: "2027-12-31" });
    expect(s.taxable).toBe(0);                    // 35,000 + 14,000 = 49,000 ≤ 90,000
    expect(s.non_taxable).toBe(14000);
  });

  it("other benefit: only the part above the ceiling is taxable, less what was taxed earlier", () => {
    expect(subsidyForPayslip({ balance: balance(), benefits_ytd: 35000 }, DEC, 40000).taxable).toBe(9000);
    expect(subsidyForPayslip({ balance: balance(), benefits_ytd: 35000, excess_taxed_ytd: 4000 }, DEC, 40000).taxable).toBe(5000);
  });

  it("taxable flag: the payout and adjustments are taxable; an advance released this month is taxed, not paid", () => {
    const s = subsidyForPayslip({ balance: balance({ tax_treatment: "taxable" }), memo_advances: [{ principal: 3000, date_granted: "2027-12-03" }] }, DEC, 90000);
    expect(s.taxable).toBe(14000);
    expect(s.extra_taxable).toBe(3000);
    expect(s.memos[0].text).toContain("not deducted from salary");
  });

  it("exempt flag: never taxed", () => {
    expect(subsidyForPayslip({ balance: balance({ tax_treatment: "exempt" }), benefits_ytd: 500000 }, DEC, 90000).taxable).toBe(0);
  });

  it("not the payout month: no payout, but approved adjustments are paid", () => {
    const s = subsidyForPayslip({ balance: balance({ payout_period_start: "2027-12-16" }), adjustments: [{ id: "adj", amount: 2000, months_missed: 1, months_label: "Jul 2027", tax_treatment: "other_benefit" }] },
      { start_key: "2027-08-16", end_key: "2027-08-31" }, 90000);
    expect(s.payout).toBe(0);
    expect(s.earnings_total).toBe(2000);
    expect(s.adjustment_ids).toEqual(["adj"]);
    expect(s.settlement).toBe(null);
  });

  it("an approved prior-year excess is offset against the payout, up to the payout", () => {
    const s = subsidyForPayslip({ balance: balance({ advances_total: 0 }), prior_offsets: [{ id: "old", remaining_balance: 30000, date_granted: "2026-06-01" }] }, DEC, 90000);
    expect(s.payout).toBe(24000);
    expect(s.prior_offset).toBe(24000);
    expect(s.loan_payments).toEqual([{ loan_id: "old", kind: "subsidy_offset", amount: 24000, amount_due: 30000 }]);
  });

  it("advances above the entitlement pay nothing out (the excess is handled in Loans / Approvals)", () => {
    expect(subsidyForPayslip({ balance: balance({ entitlement: 18000, advances_total: 20000 }) }, DEC, 90000).payout).toBe(0);
  });
});

describe("License rules", () => {
  it("status: off, pending, eligible, expiring (60 days), expired", () => {
    const today = "2027-01-10";
    expect(licenseStatus({ is_licensed_teacher: false }, today).code).toBe("not_licensed");
    expect(licenseStatus({ is_licensed_teacher: true, license_expires_on: "2030-03-03" }, today).code).toBe("pending");
    expect(licenseStatus({ is_licensed_teacher: true, license_expires_on: "2030-03-03", license_verified_at: "x" }, today)).toMatchObject({ code: "eligible", eligible: true });
    expect(licenseStatus({ is_licensed_teacher: true, license_expires_on: "2027-02-20", license_verified_at: "x" }, today)).toMatchObject({ code: "expiring", label: "Expiring in 41 days", eligible: true });
    expect(licenseStatus({ is_licensed_teacher: true, license_expires_on: "2027-01-09", license_verified_at: "x" }, today)).toMatchObject({ code: "expired", eligible: false });
  });

  it("validation: number and future expiry to turn on; a reason always", () => {
    expect(validateLicenseChange("turn_on", { reason: "New license", prc_license_no: "0123456", license_expires_on: "2030-03-03" }, "2027-01-10")).toBe(null);
    expect(validateLicenseChange("turn_on", { reason: "x", prc_license_no: "0123456", license_expires_on: "2030-03-03" }, "2027-01-10")).toMatch(/reason/);
    expect(validateLicenseChange("turn_on", { reason: "New license", license_expires_on: "2030-03-03" }, "2027-01-10")).toMatch(/number/);
    expect(validateLicenseChange("turn_on", { reason: "New license", prc_license_no: "0123456", license_expires_on: "2027-01-10" }, "2027-01-10")).toMatch(/after today/);
    expect(validateLicenseChange("update_details", { reason: "Renewed" }, "2027-01-10")).toMatch(/Change the number/);
  });
});

/* ── Worked example 7.4 through the payroll API ──────────────────────────── */

const BRANCH = "b-main";
const ANA = "u-ana";
const BEN = "u-ben";
const BIR = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]];
const rate = (rateType, value, effectiveDate = "2026-01-01") => ({
  id: `cfg-${rateType}-${effectiveDate}`, rate_type: rateType, scope: "global", scope_ref: null, value, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`,
});

let payroll;
let license;
let createSessionToken;
let SESSION_COOKIE;
const who = {
  accountant: { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" },
  hr: { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Rita HR" },
  admin: { user_id: "u-adm", role: "admin", branch_id: BRANCH, full_name: "Ada Admin" },
};
function call(handler, path, method, body, as, query = "") {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: "s-1" });
  return handler(new Request(`https://sacs.test${path}${query}`, {
    method, headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, body: body ? JSON.stringify(body) : undefined,
  }));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2028-01-02T10:00:00+08:00"));
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SESSION_SECRET = "test-secret-subsidy";
  resetDb();
  users.push(
    { id: ANA, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Reyes", employee_id: "SACS-020", basic_salary: 25000, branch_id: BRANCH } },
    { id: BEN, email: "ben@sacs.test", user_metadata: { role: "employee", full_name: "Ben Cruz", employee_id: "SACS-021", basic_salary: 20000, branch_id: BRANCH } },
  );
  table("branches").push({ id: BRANCH, name: "Main" });
  table("profiles").push(
    { id: "u-acct", branch_id: BRANCH }, { id: "u-hr", branch_id: null }, { id: "u-adm", branch_id: BRANCH },
    { id: ANA, full_name: "Ana Reyes", branch_id: BRANCH, employee_type: "Teaching", employee_status: "Active", is_licensed_teacher: true,
      prc_license_no_last4: "3456", license_expires_on: "2030-03-03", license_verified_at: "2027-01-02T00:00:00Z", license_verified_by_name: "Rita HR" },
    { id: BEN, full_name: "Ben Cruz", branch_id: BRANCH, employee_type: "Teaching", employee_status: "Active", is_licensed_teacher: false },
  );
  table("payroll_rate_configs").push(
    rate("hourly", 0), rate("daily", 0), rate("half_day_pct", 50), rate("absent_pct", 100),
    rate("late_minute_charge_pct", 0), rate("early_bird_bonus", 0), rate("perfect_attendance_bonus", 0),
    ...Object.entries({
      overtime_premium_pct: 0, working_days_per_year: 261, late_days_per_absent: 0, payroll_per_half: 0,
      contribution_method: 1, contribution_half: 2, sss_fixed: 400, philhealth_fixed: 0, pagibig_fixed: 200,
      attendance_lock_day: 15, carry_after_lock: 1,
    }).map(([type, value]) => rate(type, value, "2026-10-01")),
  );
  table("payroll_tax_brackets").push(...BIR.map(([over, base, pct]) => ({ id: `bir-${over}`, version_id: "bir", effective_date: "2023-01-01", bracket_over: over, base_tax: base, rate_pct: pct, created_at: "2023-01-01T00:00:00Z" })));
  table("payroll_entries").push({
    id: "ana-dec1", employee_id: ANA, employee_name: "Ana Reyes", pay_period: "December 1-15, 2027", status: "paid", payslip_no: "PS-202712-1",
    payroll: { basic_salary: 12500, basic_earned: 12500, totals: { gross_pay: 12500, total_deductions: 0, total_incentives: 0, net_pay: 12500 } },
  });
  table("payroll_subsidy_balances").push({ ...balance(), employee_id: ANA, paid_out_on: null });
  table("payroll_loans").push({ id: "adv", employee_id: ANA, loan_type: "subsidy_advance", principal: 10000, remaining_balance: 10000, status: "active", date_granted: "2027-06-10", subsidy_balance_id: "bal" });
  table("payroll_exempt_benefits_paid").push(
    { employee_id: ANA, tax_year: 2027, kind: "thirteenth_month", amount: 25000, paid_on: "2027-12-10" },
    { employee_id: ANA, tax_year: 2027, kind: "subsidy_advance", amount: 10000, paid_on: "2027-06-10" },
  );
  table("payroll_cash_advances");

  payroll = await import("@/app/api/accountant/payroll/route");
  license = await import("@/app/api/hr/teacher-license/route");
  ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
});
afterEach(() => { vi.useRealTimers(); });

const processDec = () => call(payroll.POST, "/api/accountant/payroll", "POST", {
  action: "batch_submit", pay_period: DEC.label,
  entries: [{ employee_id: ANA, basic_salary: 25000, deductions: { sss: 400, philhealth: 0, pagibig: 200 } }],
}, who.accountant);

describe("Worked example 7.4: the December 16–31, 2027 payslip pays the ₱14,000 balance", () => {
  it("net ₱25,364.95; subsidy tax-exempt (49,000 ≤ 90,000); balance paid out; advance closed", async () => {
    const response = await processDec();
    expect(response.status).toBe(200);
    const entry = table("payroll_entries").find((e) => e.employee_id === ANA && e.pay_period === DEC.label);
    expect(entry.payroll.subsidy).toMatchObject({ payout: 14000, taxable: 0, non_taxable: 14000 });
    expect(entry.payroll.totals.net_pay).toBe(25364.95);
    expect(table("payroll_deductions").find((l) => l.employee_id === ANA && l.type === "withholding_tax").amount).toBe(535.05);
    expect(table("payroll_incentives").find((l) => l.type === "subsidy")).toMatchObject({ amount: 14000 });
    expect(table("payroll_subsidy_balances")[0]).toMatchObject({ status: "paid_out", paid_out: 14000 });
    expect(table("payroll_loans")[0]).toMatchObject({ remaining_balance: 0, status: "paid" });
    expect(table("payroll_loan_payments").find((p) => p.kind === "subsidy_offset")).toMatchObject({ loan_id: "adv", amount: 10000 });
  });

  it("with the ceiling lowered to ₱40,000 the ₱9,000 excess is taxed: tax ₱1,888.40", async () => {
    table("payroll_rate_configs").push(rate("benefits_exempt_ceiling", 40000, "2027-01-01"));
    expect((await processDec()).status).toBe(200);
    const entry = table("payroll_entries").find((e) => e.employee_id === ANA && e.pay_period === DEC.label);
    expect(entry.payroll.subsidy.taxable).toBe(9000);
    expect(entry.payroll.benefits_excess_taxed).toBe(9000);
    expect(table("payroll_deductions").find((l) => l.employee_id === ANA && l.type === "withholding_tax").amount).toBe(1888.4);
    expect(entry.payroll.totals.net_pay).toBe(24011.6);
  });
});

describe("License API", () => {
  it("HR, Admin and Super Admin can read; Admin gets no document id; the Accountant has no access", async () => {
    const asHr = await (await call(license.GET, "/api/hr/teacher-license", "GET", null, who.hr)).json();
    expect(asHr.teachers.find((t) => t.employee_id === ANA)).toMatchObject({ prc_license_masked: "••••3456", status: { code: "eligible" }, verified_by_name: "Rita HR" });
    expect(asHr.can_edit).toBe(true);
    const asAdmin = await (await call(license.GET, "/api/hr/teacher-license", "GET", null, who.admin)).json();
    expect(asAdmin.can_edit).toBe(false);
    expect("document_id" in asAdmin.teachers[0]).toBe(false);
    expect((await call(license.GET, "/api/hr/teacher-license", "GET", null, who.accountant)).status).toBe(403);
  });

  it("only HR changes licenses; the change is recorded through employee_license_changes", async () => {
    const turnOn = { action: "turn_on", employee_id: BEN, prc_license_no: "998877", license_expires_on: "2031-01-01", reason: "PRC license submitted" };
    expect((await call(license.POST, "/api/hr/teacher-license", "POST", turnOn, who.admin)).status).toBe(403);
    expect((await call(license.POST, "/api/hr/teacher-license", "POST", { ...turnOn, license_expires_on: "2027-01-01" }, who.hr)).status).toBe(400);
    expect((await call(license.POST, "/api/hr/teacher-license", "POST", turnOn, who.hr)).status).toBe(200);
    expect(table("employee_license_changes")[0]).toMatchObject({ employee_id: BEN, action: "turn_on", prc_license_no: "998877", changed_by_role: "hr", changed_by: "u-hr" });
    // The audit trail never holds the full number.
    const audit = table("audit_logs").find((a) => a.action === "teacher_license_turn_on");
    expect(JSON.stringify(audit)).not.toContain("998877");
  });

  it("a PRC ID must be a PDF / PNG / JPEG data URL", async () => {
    const bad = { action: "turn_on", employee_id: BEN, prc_license_no: "998877", license_expires_on: "2031-01-01", reason: "PRC license submitted", document: { data_url: "<script>x</script>", file_name: "a.html" } };
    expect((await call(license.POST, "/api/hr/teacher-license", "POST", bad, who.hr)).status).toBe(400);
    const good = { ...bad, document: { data_url: "data:image/png;base64,iVBORw0KGgo=", file_name: "prc.png" } };
    expect((await call(license.POST, "/api/hr/teacher-license", "POST", good, who.hr)).status).toBe(200);
    expect(table("employee_license_documents")).toHaveLength(1);
  });
});
