/**
 * Real-world scenarios (SCENARIOS.md, 2026-10-22) checked without a database;
 * the end-to-end side is e2e/specs/95-scenarios.spec.mjs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SEPARATION_REASONS, validateSeparation } from "@/lib/employees/separation-rules";
import { describeCorrectionError, shapeCorrection } from "@/lib/payroll/corrections";

describe("EM-08 / HR-03: separation", () => {
  it("needs the last day, a known reason, and grounds for a termination", () => {
    expect(SEPARATION_REASONS).toEqual(["Resigned", "End of contract", "Retired", "Terminated", "Deceased", "Other"]);
    expect(validateSeparation({ effective: "2027-05-31", reason: "Resigned" })).toBeNull();
    expect(validateSeparation({ effective: "31/05/2027", reason: "Resigned" })).toMatch(/last day/);
    expect(validateSeparation({ effective: "2027-05-31", reason: "Fired" })).toMatch(/reason/);
    expect(validateSeparation({ effective: "2027-05-31", reason: "Terminated", note: "short" })).toMatch(/grounds/);
    expect(validateSeparation({ effective: "2020-01-01", reason: "Resigned" }, { dateHired: "2021-06-01" })).toMatch(/before the date hired/);
  });
  it("the separation goes through the AWOL decision's status change and deactivates the card", () => {
    const lib = readFileSync("src/lib/employees/separation.js", "utf8");
    expect(lib).toContain('status: "Separated"');
    expect(lib).toContain('p_action: "deactivate"');
  });
});

describe("AC-08: payroll corrections", () => {
  it("maps database refusals to HTTP answers", () => {
    expect(describeCorrectionError({ message: "forbidden: only HR approves or rejects a payroll correction." })).toMatchObject({ status: 403, code: "forbidden" });
    expect(describeCorrectionError({ message: "duplicate: this payslip already has a correction waiting." })).toMatchObject({ status: 409 });
    expect(describeCorrectionError({ message: 'relation "payroll_corrections" does not exist' })).toMatchObject({ status: 503, code: "not_ready" });
  });
  it("shapes a row with its labels and history", () => {
    const shaped = shapeCorrection({ id: "c1", kind: "overpayment", status: "rejected", amount: "1000.00", payrolls: 2, history: [{ action: "filed" }] });
    expect(shaped).toMatchObject({ kind_label: "Overpayment (recover it)", status_label: "Rejected by HR", amount: 1000, payrolls: 2 });
  });
  it("the migration keeps the role rules in the database: Accountant files (not own), HR decides (not the filer)", () => {
    const sql = readFileSync("supabase/migrations/20261022020000_payroll_corrections.sql", "utf8");
    expect(sql).toMatch(/v_actor\.role::TEXT <> 'accountant'/);
    expect(sql).toMatch(/v_entry\.employee_id = v_actor\.id/);
    expect(sql).toMatch(/v_actor\.role::TEXT <> 'hr'/);
    expect(sql).toMatch(/v_row\.requested_by = v_actor\.id/);
    expect(sql).toMatch(/COALESCE\(v_run_status, ''\) <> 'approved'/);
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("payroll_corrections_block_hard_delete");
  });
});

describe("EM-03: a time in hours before the shift is refused", () => {
  it("the tap route refuses card time-ins more than 3 hours early (manual entry is not judged)", () => {
    const route = readFileSync("src/app/api/admin/attendance/route.js", "utf8");
    expect(route).toContain("const EARLY_TAP_LIMIT_HOURS = 3;");
    expect(route).toMatch(/if \(!manualEntry\) \{\s*const tooEarly = await tooEarlyTimeIn/);
    expect(route).toContain('code: "too_early"');
  });
});

describe("X-03: typing in a form keeps the session alive", () => {
  it("real input renews the session at most once a minute", () => {
    const session = readFileSync("src/components/portal/session.jsx", "utf8");
    expect(session).toContain("const ACTIVITY_RENEW_MS = 60000;");
    expect(session).toMatch(/addEventListener\("keydown", onInput, true\)/);
    expect(session).toContain('"x-sacs-activity": "1"');
  });
});

describe("X-01: two people editing one employee", () => {
  it("the save carries the version it opened and a changed record is refused", () => {
    const route = readFileSync("src/app/api/hr/employees/route.js", "utf8");
    expect(route).toContain('code: "stale_record"');
    expect(readFileSync("src/app/hr/employee-form-dialog.jsx", "utf8")).toContain("expected_updated_at: employee.updated_at");
  });
});

describe("SC-09 / SC-14: database size", () => {
  it("the Super Admin sees the size against the plan, warned from 350 MB", () => {
    const route = readFileSync("src/app/api/admin/system/route.js", "utf8");
    expect(route).toContain("warn_bytes: 350 * 1024 * 1024");
    expect(route).toContain("limit_bytes: 500 * 1024 * 1024");
  });
});

describe("EM-07: a transfer mid-period lists the days per branch on the one payslip", async () => {
  const { buildPayslipDetails } = await import("@/lib/payroll/payslip-details");
  const { buildPayslipPdf } = await import("@/lib/payroll/payslip-pdf");
  const entry = (payroll) => ({
    id: "e1", employee_code: "SACS-001", employee_name: "Ana Lopez", employee_type: "Teaching", position: "Employee",
    pay_period: "October 16-31, 2026", status: "paid", payslip_no: "PS-1",
    payroll: { basic_salary: 9000, totals: { gross_pay: 9000, total_deductions: 0, net_pay: 9000 }, deductions: {}, ...payroll },
  });
  const days = [{ branch_id: "b1", branch_name: "Main Campus", days: 6 }, { branch_id: "b2", branch_name: "North", days: 4 }];

  it("reads them from a batch payslip and from a generated one", () => {
    expect(buildPayslipDetails(entry({ payslip_meta: { branch_name: "North", branch_days: days } })).employee.branch_days).toEqual(days);
    expect(buildPayslipDetails(entry({ generation: { status: "final", branch_name: "North", branch_days: days } })).employee.branch_days).toEqual(days);
    expect(buildPayslipDetails(entry({})).employee.branch_days).toBeNull();
  });

  it("prints them on the PDF", () => {
    const pdf = Buffer.from(buildPayslipPdf(buildPayslipDetails(entry({ payslip_meta: { branch_name: "North", branch_days: days } })))).toString("latin1");
    expect(pdf).toContain("Days by branch: Main Campus 6, North 4");
  });

  it("processing counts each tapped day at the branch it was recorded at, only when more than one", () => {
    const route = readFileSync("src/app/api/accountant/payroll/route.js", "utf8");
    expect(route).toMatch(/const ENGINE_ATTENDANCE_COLUMNS = "id,employee_id,branch_id,/);
    expect(route).toContain("if (counts.size < 2) return null;");
    expect(route).toContain("branch_days: payContext.byEmployee.get(employee.id)?.branch_days || null,");
    expect(route).toContain("branch_days: context.branch_days || null,");
  });
});
