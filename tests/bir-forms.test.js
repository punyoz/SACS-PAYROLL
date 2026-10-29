/**
 * BIR Form 2316 and the 1604-C alphalist (scenario AC-11, 2026-10-22):
 * the box mapping from paid payslips, the 13th month / benefits ceiling,
 * the annual tax, the year-end difference, the employer details, the PDF and
 * alphalist files, and who may see what (the Accountant its branch only —
 * HR, Admin and Super Admin are refused since 2026-10-29 — and the employee
 * their own for a finished year).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetDb, rpc, table, users } from "./helpers/fake-supabase.js";
import {
  alphalistRow, ALPHALIST_COLUMNS, annualTaxDue, annualTaxTable, compute2316, nameParts, payslipFigures, periodMonth, toCsv,
} from "@/lib/payroll/bir-2316";
import { birEmployerErrors, birEmployerFrom, formatTin, missingBirEmployerFields } from "@/lib/payroll/bir-employer";
import { build2316Pdf } from "@/lib/payroll/bir-2316-pdf";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

// TRAIN monthly table (2023 onward).
const MONTHLY = [
  { over: 0, base: 0, rate: 0 },
  { over: 20833, base: 0, rate: 0.15 },
  { over: 33333, base: 1875, rate: 0.2 },
  { over: 66667, base: 8541.8, rate: 0.25 },
  { over: 166667, base: 33541.8, rate: 0.3 },
  { over: 666667, base: 183541.8, rate: 0.35 },
];

const regular = (label, { basic, sss = 0, ph = 0, pi = 0, wht = 0, ot = 0, holiday = 0, incentive = 0, subsidy = 0, treatment } = {}) => ({
  pay_period: label,
  payroll: {
    basic_earned: basic,
    deductions: { sss, philhealth: ph, pagibig: pi, withholding_tax: wht },
    totals: { overtime_pay: ot, holiday_pay: holiday, other_incentive: incentive, subsidy_pay: subsidy, gross_pay: basic + ot + holiday + incentive + subsidy },
    ...(treatment ? { subsidy: { tax_treatment: treatment } } : {}),
  },
});

describe("2316 figures", () => {
  it("annualizes the monthly table onto the BIR annual figures", () => {
    const annual = annualTaxTable(MONTHLY);
    expect(annual.map((r) => r.over)).toEqual([0, 250000, 400000, 800000, 2000000, 8000000]);
    expect(annual.map((r) => r.base)).toEqual([0, 0, 22500, 102500, 402500, 2202500]);
    expect(annualTaxDue(250000, MONTHLY)).toBe(0);
    expect(annualTaxDue(600000, MONTHLY)).toBe(62500);
    expect(annualTaxDue(1000000, MONTHLY)).toBe(152500);
  });

  it("reads a regular payslip and a final pay", () => {
    const r = payslipFigures(regular("March 16-31, 2026", { basic: 14000, sss: 1350, ph: 750, pi: 200, wht: 1500, ot: 1000, holiday: 500, incentive: 300 }));
    expect(r).toMatchObject({ basic: 14000, contributions: 2300, withheld: 1500, overtime: 1000, holiday_overload: 500, incentives: 300, final_pay: false });

    const fp = payslipFigures({ payroll: { final_pay: { breakdown: { basic_earned: 20000, subsidy: { payout: 4000 }, deductions: [
      { kind: "sss", amount: 1350 }, { kind: "withholding_tax", amount: 500 }, { kind: "withholding_tax", amount: 300 }, { kind: "loan", amount: 999 },
    ] } } } }, { subsidyTreatment: "taxable" });
    expect(fp).toMatchObject({ basic: 20000, contributions: 1350, withheld: 800, subsidy_taxable: 4000, final_pay: true });

    // An "other benefit" subsidy is counted from the benefits ledger, not the payslip.
    expect(payslipFigures(regular("May 16-31, 2026", { basic: 1, subsidy: 5000 })).subsidy_taxable).toBe(0);
    expect(periodMonth("December 16-31, 2026")).toBe(12);
  });

  it("maps the year onto the boxes, caps the 13th month and shows the difference", () => {
    const payslips = [
      regular("March 1-15, 2026", { basic: 15000 }),
      regular("March 16-31, 2026", { basic: 14000, sss: 1350, ph: 750, pi: 200, wht: 1500, ot: 1000, holiday: 500, incentive: 300 }),
      regular("December 16-31, 2026", { basic: 15000, sss: 1350, ph: 750, pi: 200, wht: 2000, subsidy: 5000, treatment: "taxable" }),
    ].map((e) => ({ figures: payslipFigures(e), month: periodMonth(e.pay_period) }));
    const form = compute2316({
      year: 2026,
      employee: { date_hired: "2026-03-01" },
      payslips,
      benefits: [{ kind: "thirteenth_month", amount: 85000 }, { kind: "subsidy_payout", amount: 10000 }],
      ceiling: 90000,
      taxTable: MONTHLY,
    });
    const b = form.boxes;
    expect(b[34]).toBe(90000);
    expect(b[48]).toBe(5000);
    expect(b[36]).toBe(4600);
    expect(b[38]).toBe(94600);
    expect(b[39]).toBe(39400);
    expect(b[50]).toBe(1000);
    expect(b["51A"]).toBe(500);
    expect(b["51B"]).toBe(5300);
    expect(b[52]).toBe(51200);
    expect(b[19]).toBe(145800);
    expect(b[24]).toBe(0);
    expect(b["25A"]).toBe(3500);
    expect(form.withheld_jan_nov).toBe(1500);
    expect(form.withheld_december).toBe(2000);
    expect(form.difference).toBe(-3500);
    expect(form.settlement).toBe("refund");
    expect(form.period_from).toBe("2026-03-01");
    expect(form.period_to).toBe("2026-12-31");
  });

  it("finds an under-withholding and a mid-year separation", () => {
    const payslips = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, figures: { basic: 50000, contributions: 0, withheld: 1000 } }));
    const form = compute2316({ year: 2026, employee: { date_hired: "2020-01-01", separated_on: "2026-12-15" }, payslips, taxTable: MONTHLY });
    expect(form.boxes[23]).toBe(600000);
    expect(form.boxes[24]).toBe(62500);
    expect(form.difference).toBe(62500 - 12000);
    expect(form.settlement).toBe("collect");
    expect(form.separated_in_year).toBe(true);
    expect(form.period_to).toBe("2026-12-15");
  });

  it("writes alphalist rows in column order, with substituted filing only when balanced", () => {
    const form = compute2316({ year: 2026, payslips: [{ month: 1, figures: { basic: 10000 } }], taxTable: MONTHLY });
    const row = alphalistRow({ seq: 1, tin: "123-456-789-00000", name: nameParts({ last_name: "Dela Cruz", first_name: "Juan", middle_name: "S" }), form });
    expect(row).toHaveLength(ALPHALIST_COLUMNS.length);
    expect(row.slice(0, 5)).toEqual([1, "123-456-789-00000", "Dela Cruz", "Juan", "S"]);
    expect(row[row.length - 1]).toBe("Yes");
    expect(nameParts({ full_name: "Maria Clara Santos" })).toEqual({ last: "Santos", first: "Maria Clara", middle: "" });
    expect(toCsv(["a", "b"], [["x,y", "say \"hi\""]])).toBe("a,b\r\n\"x,y\",\"say \"\"hi\"\"\"\r\n");
  });
});

describe("BIR employer details", () => {
  it("formats the TIN and checks the fields, all optional", () => {
    expect(formatTin("123456789")).toBe("123-456-789-00000");
    expect(formatTin("123-456-789-001")).toBe("123-456-789-00100");
    expect(formatTin("")).toBe("");
    expect(birEmployerErrors({})).toEqual({});
    expect(Object.keys(birEmployerErrors({ bir_employer_tin: "12", bir_rdo_code: "46", bir_zip_code: "18700" })).sort())
      .toEqual(["bir_employer_tin", "bir_rdo_code", "bir_zip_code"]);
    const employer = birEmployerFrom({ bir_employer_name: " SACS Inc. ", bir_employer_tin: "123456789" });
    expect(employer.bir_employer_name).toBe("SACS Inc.");
    expect(missingBirEmployerFields(employer)).toEqual(["RDO code", "Registered address", "ZIP code", "Authorized signatory", "Signatory's title"]);
  });
});

describe("2316 PDF", () => {
  it("writes one page per employee", () => {
    const form = compute2316({ year: 2026, payslips: [{ month: 1, figures: { basic: 10000 } }], taxTable: MONTHLY });
    const row = { employee_code: "SACS-001", full_name: "Juan Dela Cruz", name: { last: "Dela Cruz", first: "Juan", middle: "" }, tin: "123-456-789-00000", form };
    const pdf = build2316Pdf([row, { ...row, full_name: "Ana Reyes" }], { employer: birEmployerFrom({ bir_employer_name: "SACS Inc." }), year: 2026 }).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Count 2");
    expect(pdf.match(/\/Type \/Page /g)).toHaveLength(2);
    expect(pdf).toContain("(Juan Dela Cruz)");
    expect(pdf).toContain("(SACS Inc.)");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});

/* ── Routes ─────────────────────────────────────────────────────────────── */

const MAIN = "b-main";
const OTHER = "b-other";
const who = {
  hr: { user_id: "u-hr", role: "hr", branch_id: null, full_name: "Rita HR" },
  accountant: { user_id: "u-acct", role: "accountant", branch_id: MAIN, full_name: "Ana Accountant" },
  admin: { user_id: "u-adm", role: "admin", branch_id: MAIN, full_name: "Ada Admin" },
  super_admin: { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super" },
  paolo: { user_id: "u-paolo", role: "employee", branch_id: MAIN, full_name: "Paolo Diaz" },
};

let createSessionToken;
let SESSION_COOKIE;

async function call(path, as) {
  const token = createSessionToken({ ...as, email: `${as.user_id}@sacs.test`, session_id: "s-1" });
  const mod = path.startsWith("/api/employee") ? await import("@/app/api/employee/bir-2316/route") : await import("@/app/api/payroll/bir-forms/route");
  return mod.GET(new Request(`https://sacs.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
}

describe("BIR forms routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-02-01T02:00:00Z"));
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-bir-forms";
    resetDb();
    const emp = (id, name, branch, dob) => ({ id, email: `${id}@sacs.test`, user_metadata: { role: "employee", full_name: name, branch_id: branch, date_of_birth: dob } });
    users.push(emp("u-paolo", "Paolo Diaz", MAIN, "1990-05-01"), emp("u-far", "Far Away", OTHER, "1985-01-01"));
    table("branches").push({ id: MAIN, name: "Pasig" }, { id: OTHER, name: "Antipolo" });
    table("profiles").push(
      { id: "u-paolo", full_name: "Paolo Diaz", first_name: "Paolo", last_name: "Diaz", employee_id: "SACS-010", branch_id: MAIN, date_hired: "2020-06-01", employee_status: "Active" },
      { id: "u-far", full_name: "Far Away", first_name: "Far", last_name: "Away", employee_id: "SACS-011", branch_id: OTHER, date_hired: "2026-02-01", employee_status: "Active" },
      { id: "u-hr", role: "hr", branch_id: null, archived: false },
      { id: "u-adm", role: "admin", branch_id: MAIN, archived: false },
      { id: "u-acct", role: "accountant", branch_id: MAIN, archived: false },
    );
    table("system_config").push({ section: "general", key: "bir_employer_name", value: "SACS Inc." }, { section: "general", key: "bir_employer_tin", value: "111222333" });
    table("payroll_tax_brackets").push(...MONTHLY.map((r, i) => ({ version_id: "v1", effective_date: "2023-01-01", bracket_over: r.over, base_tax: r.base, rate_pct: r.rate * 100, created_at: `2023-01-01T00:00:0${i}Z` })));
    table("payroll_runs").push({ id: "run-ok", status: "approved" }, { id: "run-wait", status: "pending" });
    const entry = (id, employee, label, basic, wht, run) => ({
      id, employee_id: employee, pay_period: label, status: "paid", run_id: run,
      payroll: { basic_earned: basic, deductions: { sss: 0, philhealth: 0, pagibig: 0, withholding_tax: wht }, totals: { gross_pay: basic } },
    });
    table("payroll_entries").push(
      entry("e1", "u-paolo", "March 1-15, 2026", 15000, 100, null),
      entry("e2", "u-paolo", "October 1-15, 2026", 15000, 200, "run-ok"),
      // Still with HR: not on the forms.
      entry("e3", "u-paolo", "November 1-15, 2026", 15000, 400, "run-wait"),
      entry("e4", "u-far", "March 1-15, 2026", 9000, 0, null),
      entry("e5", "u-paolo", "March 1-15, 2025", 15000, 50, null),
      { id: "e6", employee_id: "u-paolo", pay_period: "October 16-31, 2026", status: "draft", payroll: { basic_earned: 99999 } },
    );
    table("payroll_exempt_benefits_paid").push({ employee_id: "u-paolo", tax_year: 2026, kind: "thirteenth_month", amount: 2500, paid_on: "2026-12-10" });
    rpc.results.get_profiles_pii = { data: [{ id: "u-paolo", tin_number: "123456789" }, { id: "u-far", tin_number: "" }], error: null };
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  afterEach(() => vi.useRealTimers());

  it("gives the Accountant its branch, from approved payslips only, with TINs masked", async () => {
    const response = await call("/api/payroll/bir-forms?year=2026", who.accountant);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows.map((r) => r.full_name)).toEqual(["Paolo Diaz"]);
    const paolo = body.rows[0];
    expect(paolo.gross).toBe(32500);
    expect(paolo.tax_withheld).toBe(300);
    expect(paolo.payslip_count).toBe(2);
    expect(paolo.tin_masked).toBe("••••6789");
    expect(JSON.stringify(body)).not.toContain("123456789");
    expect(body.can_generate).toBe(true);
    expect(body.finished).toBe(true);
    expect(body.employer_missing).toContain("RDO code");
    expect(body.years).toEqual([2026, 2025]);
  });

  it("refuses HR, the Super Admin, the Admin and the employee (Accountant only, 2026-10-29)", async () => {
    for (const path of ["/api/payroll/bir-forms?year=2026", "/api/payroll/bir-forms?year=2026&format=pdf", "/api/payroll/bir-forms?year=2026&format=xlsx", "/api/payroll/bir-forms?year=2026&format=csv"]) {
      expect((await call(path, who.hr)).status, `hr ${path}`).toBe(403);
      expect((await call(path, who.super_admin)).status, `super_admin ${path}`).toBe(403);
    }
    expect((await call("/api/payroll/bir-forms?year=2026", who.admin)).status).toBe(403);
    expect((await call("/api/payroll/bir-forms?year=2026", who.paolo)).status).toBe(403);
    const route = await import("@/app/api/payroll/bir-forms/route");
    expect(route.POST || route.PATCH || route.PUT || route.DELETE).toBeUndefined();
  });

  it("downloads the 2316 PDF and the alphalist, and logs it", async () => {
    const pdf = await call("/api/payroll/bir-forms?year=2026&format=pdf", who.accountant);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).toString("latin1")).toContain("/Count 1");

    const csv = await call("/api/payroll/bir-forms?year=2026&format=csv", who.accountant);
    const text = await csv.text();
    expect(text).toContain("123-456-789-00000");
    // School-wide (decision 2026-10-29): the other branch's Far Away is listed too, by last name.
    expect(text.split("\r\n")[1].startsWith("1,1,,Away,Far")).toBe(true);
    expect(text.split("\r\n")[2].startsWith("1,2,123-456-789-00000,Diaz,Paolo")).toBe(true);

    const xlsx = await call("/api/payroll/bir-forms?year=2026&format=xlsx", who.accountant);
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    expect(table("audit_logs").filter((log) => log.action === "bir_forms_export")).toHaveLength(3);

    // Another branch's employee is not reachable by id.
    expect((await call("/api/payroll/bir-forms?year=2026&format=pdf&employee_id=00000000-0000-0000-0000-000000000000", who.accountant)).status).toBe(404);
  });

  it("gives the employee their own 2316 for a finished year only", async () => {
    const list = await (await call("/api/employee/bir-2316", who.paolo)).json();
    expect(list.years).toEqual([2026, 2025]);
    expect((await call("/api/employee/bir-2316?year=2027&format=pdf", who.paolo)).status).toBe(400);
    const pdf = await call("/api/employee/bir-2316?year=2026&format=pdf", who.paolo);
    expect(pdf.status).toBe(200);
    const text = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    expect(text).toContain("/Count 1");
    expect(text).toContain("(Paolo Diaz)");
    expect(text).not.toContain("Far Away");
  });

  it("is mapped in the proxy", async () => {
    const { proxy } = await import("@/proxy");
    const as = (role, path) => {
      const token = createSessionToken({ ...who[role], email: `${who[role].user_id}@sacs.test`, session_id: "s-1" });
      return new NextRequest(`https://sacs.test${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    };
    users.find((u) => u.id === "u-paolo").app_metadata = { session_id: "s-1" };
    users.push({ id: "u-hr", email: "u-hr@sacs.test", app_metadata: { session_id: "s-1" }, user_metadata: { role: "hr" } });
    users.push({ id: "u-acct", email: "u-acct@sacs.test", app_metadata: { session_id: "s-1" }, user_metadata: { role: "accountant" } });
    users.push({ id: "u-sa", email: "u-sa@sacs.test", app_metadata: { session_id: "s-1" }, user_metadata: { role: "super_admin" } });
    expect((await proxy(as("accountant", "/api/payroll/bir-forms"))).status).toBe(200);
    expect((await proxy(as("hr", "/api/payroll/bir-forms"))).status).toBe(403);
    expect((await proxy(as("super_admin", "/api/payroll/bir-forms"))).status).toBe(403);
    expect((await proxy(as("paolo", "/api/payroll/bir-forms"))).status).toBe(403);
    expect((await proxy(as("paolo", "/api/employee/bir-2316"))).status).toBe(200);
  });
});
