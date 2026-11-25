/**
 * Government loans and cash advances (2026-11-25): the school does not lend; SSS / Pag-IBIG loans are
 * encoded by HR, deducted on 16–end payslips with the agency on the line, never limited by the salary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { deductionLabel, scheduleLoans, validateGovernmentLoanInput, validateLoanInput } from "@/lib/payroll/loans";
import { buildRemittance } from "@/lib/payroll/remittance";
import { computeFinalPay } from "@/lib/payroll/final-pay";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const OCT2 = { start_key: "2026-10-16" };
const OCT1 = { start_key: "2026-10-01" };
const gov = (o = {}) => ({
  id: "g1", loan_type: "sss_loan", agency: "SSS", loan_kind: "salary loan", reference_no: "SSS-123", status: "active", approval_status: "approved",
  amortization: 1000, balance: 12000, start_period: "2026-10-16", date_granted: "2026-10-01", created_at: "2026-10-01T00:00:00Z", ...o,
});

describe("the words", () => {
  it("one line per deduction, naming the agency", () => {
    expect(deductionLabel(gov())).toBe("SSS loan (salary loan)");
    expect(deductionLabel(gov({ loan_type: "pagibig_loan", agency: "Pag-IBIG", loan_kind: "multi-purpose" }))).toBe("Pag-IBIG loan (multi-purpose)");
    expect(deductionLabel({ loan_type: "cash_advance" })).toBe("Cash advance");
    expect(deductionLabel({ loan_type: "salary_loan" })).toBe("Cash advance (legacy salary loan)");
  });

  it("no school loan can be filed; a government loan has no amount cap", () => {
    expect(validateLoanInput({ loan_type: "salary_loan" })).toMatch(/does not give loans/);
    expect(validateLoanInput({ loan_type: "emergency_loan" })).toMatch(/does not give loans/);
    const input = { loan_type: "sss_loan", loan_kind: "salary loan", reference_no: "SSS-1", principal: 900000, amortization: 5000, number_of_payrolls: 120, start_period: "2026-12-16" };
    expect(validateGovernmentLoanInput(input)).toBeNull();
    expect(validateGovernmentLoanInput({ ...input, loan_type: "salary_loan" })).toMatch(/agency/);
    expect(validateGovernmentLoanInput({ ...input, start_period: "2026-12-01" })).toMatch(/16–end/);
    expect(validateGovernmentLoanInput({ ...input, reference_no: "bad;ref" })).toMatch(/reference/);
  });
});

describe("deduction (2nd half only, what fits)", () => {
  it("SSS and Pag-IBIG each their own line on the 2nd half; nothing on the 1st half", () => {
    const loans = [gov(), gov({ id: "g2", loan_type: "pagibig_loan", agency: "Pag-IBIG", loan_kind: "multi-purpose", reference_no: null, amortization: 800, balance: 9600 })];
    expect(scheduleLoans({ loans, period: OCT1, available: 50000 }).lines).toEqual([]);
    const { lines, total } = scheduleLoans({ loans, period: OCT2, available: 50000 });
    expect(lines.map((l) => [l.description, l.agency, l.amount, l.balance_after, l.reference_no])).toEqual([
      ["SSS loan (salary loan)", "SSS", 1000, 11000, "SSS-123"],
      ["Pag-IBIG loan (multi-purpose)", "Pag-IBIG", 800, 8800, null],
    ]);
    expect(total).toBe(1800);
  });

  it("net pay too low: deducts what fits, the rest stays; suspended skipped; a zero balance stops", () => {
    const { lines } = scheduleLoans({ loans: [gov(), gov({ id: "g2", status: "suspended" }), gov({ id: "g3", balance: 0 })], period: OCT2, available: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 600, shortfall: 400, balance_after: 11400 });
  });
});

describe("Remittances", () => {
  it("SSS and Pag-IBIG loan payments per employee, separate from contributions, with totals", () => {
    const entry = (employee, loans) => ({ employee_id: employee, employee_name: employee, status: "paid", payroll: { deductions: { sss: 1000 }, loans } });
    const r = buildRemittance([
      entry("a", [{ loan_type: "sss_loan", amount: 1000 }, { loan_type: "pagibig_loan", amount: 800 }, { loan_type: "cash_advance", amount: 500 }]),
      entry("b", [{ loan_type: "sss_loan", amount: 700 }]),
    ]);
    expect(r.rows.find((x) => x.employee_id === "a")).toMatchObject({ sss_ee: 1000, sss_loan: 1000, pagibig_loan: 800 });
    expect(r.totals).toMatchObject({ sss_loan: 1700, pagibig_loan: 800, sss_ee: 2000 });
  });

  it("no government loan: ₱0 columns", () => {
    const r = buildRemittance([{ employee_id: "a", status: "paid", payroll: { deductions: { sss: 1000 }, loans: [] } }]);
    expect(r.totals).toMatchObject({ sss_loan: 0, pagibig_loan: 0 });
  });
});

describe("Final pay (decision 2026-11-25)", () => {
  // The worked example of tests/final-pay.test.js (Maria, separated Dec 7, 2026), with an SSS loan.
  const BIR = [[0, 0, 0], [20833, 0, 15], [33333, 1875, 20], [66667, 8541.8, 25], [166667, 33541.8, 30], [666667, 183541.8, 35]]
    .map(([over, base, pct]) => ({ over, base, rate: pct / 100 }));
  const input = (loan) => ({
    monthlySalary: 30000, dailyRate: 1379.31, separatedOn: "2026-12-07",
    months: [
      { month_key: "2026-11", window: { start_key: "2026-10-30", end_key: "2026-11-26" }, absent_days: 14, first_half_paid: 0 },
      { month_key: "2026-12", window: { start_key: "2026-11-27", end_key: "2026-12-28" }, absent_days: 6, first_half_paid: 0, partial: { paid: 0, unpaid_holidays: ["2026-11-30"] } },
    ],
    contributions: { sss: 400, philhealth: 0, pagibig: 200 }, taxTable: BIR, basicEarnedYtd: 270000 + 28491.38, thirteenthPaid: false,
    subsidy: null, benefitsYtd: 0, ceiling: 90000, carryIn: 0,
    loans: [{ id: "sss", loan_type: "sss_loan", agency: "SSS", loan_kind: "salary loan", reference_no: "SSS-9", remaining_balance: 5000, date_granted: "2026-10-05", ...loan }],
  });

  it("without the signed authority: not deducted; listed for HR; the employee pays SSS directly", () => {
    const r = computeFinalPay(input({ final_pay_authorized: false }));
    expect(r.loan_payments).toEqual([]);
    expect(r.uncovered[0]).toMatchObject({ loan_id: "sss", amount: 5000 });
    expect(r.uncovered[0].reason).toBe("SSS loan (salary loan): no signed final-pay authority; the employee pays SSS directly");
  });

  it("with the signed authority: deducted as before, in the agency's words", () => {
    const r = computeFinalPay(input({ final_pay_authorized: true }));
    expect(r.loan_payments).toEqual([expect.objectContaining({ loan_id: "sss", kind: "final_pay", amount: 5000 })]);
    expect(r.deductions.find((d) => d.kind === "loan")).toMatchObject({ label: "SSS loan (salary loan) balance", amount: 5000 });
  });
});

/* ── /api/hr/government-loans ────────────────────────────────────────────── */

const BRANCH = "b-main";
let api;
let createSessionToken;
let SESSION_COOKIE;
const who = {
  hr: { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Hana HR" },
  hr2: { user_id: "u-hr2", role: "hr", branch_id: null, full_name: "Hugo HR" },
  sa: { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" },
  acct: { user_id: "u-acct", role: "accountant", branch_id: BRANCH, full_name: "Ana Accountant" },
  emp: { user_id: "u-emp", role: "employee", branch_id: BRANCH, full_name: "Ella Employee" },
  admin: { user_id: "u-adm", role: "admin", branch_id: BRANCH, full_name: "Ada Admin" },
};
const request = (method, body, as) => {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: "s-1" });
  return new Request("https://sacs.test/api/hr/government-loans", { method, headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, body: body ? JSON.stringify(body) : undefined });
};
const encode = (body = {}, as = who.hr) => api.POST(request("POST", {
  employee_id: "u-emp", loan_type: "sss_loan", loan_kind: "salary loan", reference_no: "SSS-9", principal: 24000, amortization: 1000,
  start_period: "2026-11-16", ...body,
}, as));

describe("HR encodes government loans", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00+08:00"));
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-gov-loans";
    resetDb();
    const person = (id, role, name, branch = BRANCH) => ({ id, email: `${id}@sacs.test`, user_metadata: { role, full_name: name, employee_id: id.toUpperCase(), branch_id: branch } });
    users.push(person("u-emp", "employee", "Ella Employee"), person("u-hr", "hr", "Hana HR", null), person("u-hr2", "hr", "Hugo HR", null),
      person("u-acct", "accountant", "Ana Accountant"), person("u-far", "employee", "Far Away", "b-other"));
    table("profiles").push(
      { id: "u-emp", full_name: "Ella Employee", branch_id: BRANCH, role: "employee" },
      { id: "u-hr", full_name: "Hana HR", role: "hr" }, { id: "u-hr2", full_name: "Hugo HR", role: "hr" },
      { id: "u-acct", full_name: "Ana Accountant", branch_id: BRANCH, role: "accountant" },
      { id: "u-far", full_name: "Far Away", branch_id: "b-other", role: "employee" },
    );
    api = await import("@/app/api/hr/government-loans/route");
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("HR encodes an SSS loan: approved at once, final-pay authority off by default, audited", async () => {
    const res = await encode();
    expect(res.status).toBe(200);
    expect(table("payroll_loans")[0]).toMatchObject({ loan_type: "sss_loan", agency: "SSS", loan_kind: "salary loan", reference_no: "SSS-9",
      principal: 24000, amortization: 1000, number_of_payrolls: 24, approval_status: "approved", final_pay_authorized: false, created_by: "u-hr" });
    expect(table("audit_logs").some((a) => a.action === "government_loan_create")).toBe(true);
  });

  it("any amount: a ₱900,000 Pag-IBIG housing loan is accepted (no cap, no salary limit)", async () => {
    expect((await encode({ loan_type: "pagibig_loan", loan_kind: "housing", reference_no: "HL-1", principal: 900000, amortization: 7500 })).status).toBe(200);
  });

  it("nobody encodes their own: HR's own loan is another HR's; the Super Admin only when there is no other HR", async () => {
    expect((await encode({ employee_id: "u-hr" }, who.hr)).status).toBe(403);
    expect((await encode({ employee_id: "u-hr" }, who.hr2)).status).toBe(200);
    expect((await encode({ employee_id: "u-hr", reference_no: "X-2" }, who.sa)).status).toBe(403);   // another HR exists
    table("profiles").find((p) => p.id === "u-hr2").archived = true;
    expect((await encode({ employee_id: "u-hr", reference_no: "X-3" }, who.sa)).status).toBe(200);   // fallback
    expect((await encode({}, who.sa)).status).toBe(403);   // the Super Admin never for an employee
  });

  it("only HR encodes: the Accountant, an employee and the Admin are refused", async () => {
    expect((await encode({}, who.acct)).status).toBe(403);
    expect((await encode({ employee_id: "u-acct" }, who.emp)).status).toBe(403);
    expect((await encode({}, who.admin)).status).toBe(403);
  });

  it("edits apply with a reason, audited; suspend / resume / end; a missing reason is refused", async () => {
    await encode();
    const id = table("payroll_loans")[0].id || (table("payroll_loans")[0].id = "gl-1");
    const patch = (body, as = who.hr) => api.PATCH(request("PATCH", { id, ...body }, as));
    expect((await patch({ action: "edit", amortization: 1200 })).status).toBe(400);
    expect((await patch({ action: "edit", amortization: 1200, reason: "New SSS notice" })).status).toBe(200);
    expect(table("payroll_loans")[0].amortization).toBe(1200);
    expect((await patch({ action: "suspend", reason: "Agency paused it" })).status).toBe(200);
    expect((await patch({ action: "resume", reason: "Agency resumed it" })).status).toBe(200);
    expect((await patch({ action: "end", reason: "Paid at the agency" })).status).toBe(200);
    expect(table("payroll_loans")[0]).toMatchObject({ status: "suspended", status_reason: "Ended: Paid at the agency" });
    expect(table("audit_logs").filter((a) => /^government_loan_/.test(a.action)).map((a) => a.action)).toEqual(
      ["government_loan_create", "government_loan_edit", "government_loan_suspend", "government_loan_resume", "government_loan_end"]);
  });

  it("the Accountant sees its branch's government loans read-only; the employee only their own", async () => {
    await encode();
    await encode({ employee_id: "u-far", reference_no: "FAR-1" });
    const list = async (as) => (await (await api.GET(request("GET", null, as))).json());
    const acct = await list(who.acct);
    expect(acct.loans.map((l) => l.employee_id)).toEqual(["u-emp"]);
    expect(acct.can_encode).toBe(false);
    const own = await list(who.emp);
    expect(own.loans.map((l) => l.employee_id)).toEqual(["u-emp"]);
  });
});
