// Every API route that answers GET, called by every role and by a signed-out
// visitor. A role on the "allow" list must get an answer that is not 401/403
// (and never a 5xx); everyone else must be refused with 401/403. The lists
// come from the decided business rules (role separation 2026-10-20, Accountant
// processes / HR approves, Super Admin runs the system but not payroll, Admin
// oversees its own branch, Employee sees only its own records), not from the
// code. Results: test-results/api-matrix.json and a table in the terminal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, signOutLocally, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { profileByEmail } from "../support/db.mjs";
import { ACCOUNTS, ROLES } from "../accounts.mjs";

const SA = "super_admin", AD = "admin", HR = "hr", AC = "accountant", EM = "employee";
const ALL = [SA, AD, HR, AC, EM];
const PUBLIC = "public"; // answers without a session

// [path, allowed roles]. `:emp` is replaced by Ana's profile id.
const ROUTES = [
  ["/api/health", PUBLIC],
  // Answers 401 with no session (that is its job: "am I signed in?").
  ["/api/legacy-auth/session", ALL],
  ["/api/dev/mailtm", PUBLIC],
  ["/api/rbac/me", ALL],
  ["/api/legacy-auth/update-profile", ALL],
  ["/api/notifications", ALL],
  ["/api/profile-photo", ALL],
  ["/api/announcements", ALL],
  ["/api/admin/branches", ALL],
  ["/api/admin/holidays", ALL],
  // Accountant only: payroll processing.
  ["/api/accountant/payroll", [AC]],
  ["/api/accountant/payroll-runs", [AC]],
  ["/api/accountant/final-pay", [AC]],
  // An Employee may call it, and gets only its own loans (loans: self scope).
  ["/api/accountant/loans", [AC, EM]],
  ["/api/payroll/bir-forms", [AC]],
  // Accountant generates, Super Admin reads; HR and others blocked.
  ["/api/payroll/bir-exports", [AC, SA]],
  ["/api/payroll/year-end-tax", [AC, SA]],
  // Rates: SA edits, HR and Accountant read, Employee blocked.
  ["/api/payroll/government-rates", [SA, HR, AC]],
  // HR approves payroll; the Accountant sees its own runs' status.
  ["/api/hr/payroll-runs", [HR, AC]],
  ["/api/hr/payroll-records", [HR, AC]],
  ["/api/payroll/corrections", [HR, AC]],
  ["/api/payroll/remittance", [HR, AC]],
  ["/api/admin/approvals", [HR, AC]],
  ["/api/hr/adjustment-approvals", [HR, AC]],
  // Final-payslip override: Super Admin acts, HR reads the log.
  ["/api/payroll/overrides", [SA, HR]],
  ["/api/payroll/review-flags", [SA, HR, AC]],
  // HR-owned people modules.
  ["/api/hr/employees", [SA, HR, AC]],
  ["/api/hr/leave-requests", [HR]],
  ["/api/hr/tenure-protection", [HR]],
  ["/api/hr/teacher-license", [HR]],
  ["/api/hr/reports", [HR]],
  ["/api/hr/attendance", [SA, HR, AC]],
  ["/api/hr/awol-cases", [HR, AC]],
  ["/api/hr/dashboard", [SA, AD, HR, AC]],
  // Admin endorsements as HR sees them (the Admin files and follows them in
  // Branch Oversight).
  ["/api/hr/branch-requests", [SA, HR]],
  ["/api/hr/salary-changes?employee_id=:emp", [HR]],
  ["/api/admin/transfer-requests", [HR]],
  ["/api/admin/work-schedules", [HR]],
  ["/api/admin/employees", [SA, HR, AC]],
  ["/api/admin/users", [SA, HR]],
  ["/api/admin/branch-employees", [SA, HR]],
  ["/api/admin/employee-info", [SA, AD, HR]],
  ["/api/admin/early-bird", [SA, HR, AC]],
  // Admin: its own branch's oversight (2026-10-20: attendance, lateness and
  // leave, never pay); the Accountant reads only the requests view.
  ["/api/admin/branch-oversight", [AD]],
  ["/api/admin/branch-oversight?view=requests", [AD, AC]],
  // Pay-bearing aggregates: never the Admin (it uses Branch Oversight).
  ["/api/admin/branch-reports", [SA]],
  ["/api/admin/dashboard", [SA, HR, AC]],
  ["/api/admin/system", [SA, AD]],
  ["/api/rfid/cards", [SA, AD, HR]],
  // Super Admin only: system configuration and the audit trail.
  ["/api/admin/config", [SA]],
  ["/api/admin/audit-logs", [SA]],
  ["/api/admin/payroll-rates", [SA]],
  ["/api/admin/payroll-settings", [SA]],
  ["/api/admin/payslip-schedule", [SA]],
  ["/api/admin/teacher-subsidy", [SA]],
  // Attendance.
  ["/api/admin/attendance", [SA, HR, AC]],
  ["/api/attendance/logs", [SA, HR, AC, EM]],
  ["/api/attendance/overtime", [SA, HR, AC, EM]],
  ["/api/attendance/corrections", [HR, AC, EM]],
  ["/api/attendance/employee/:emp", [HR]],
  ["/api/holiday-duty", [SA, HR, AC, EM]],
  // Employee's own records.
  ["/api/employee/payslips", [HR, AC, EM]],
  ["/api/employee/bir-2316", [HR, AC, EM]],
  ["/api/employee/stats", ALL],
  ["/api/employee/timesheet", [HR, AC, EM]],
  ["/api/employee/leave-requests", [HR, EM]],
];

/** GET and read the status only (the payroll stream never ends). */
async function statusOf(page, path) {
  return page.evaluate(async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      // Only the never-ending payroll stream is cut after its headers.
      if (url.includes("/stream")) ctrl.abort();
      else await res.text();
      return res.status;
    } catch (e) {
      return e.name === "AbortError" ? 0 : -1;
    } finally { clearTimeout(timer); }
  }, path);
}

const results = [];

test("API matrix: every GET route, every role and signed out", async ({ page, monitor }) => {
  test.setTimeout(20 * 60 * 1000);
  // Refusals are what this test is about.
  monitor.allow(/^40[01345] GET /, /status of 40/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const routes = ROUTES.map(([p, allow]) => [p.replace(":emp", ana.id), allow]);
  const shown = ["/api/hr/payroll-runs/stream"]; // listed below, checked by status only

  const identities = ["signed_out", ...ROLES];
  for (const who of identities) {
    const label = who === "signed_out" ? "Signed out" : ROLE_LABEL[who];
    monitor.at(`API matrix > ${label}`);
    if (who === "signed_out") await signOutLocally(page);
    else await as(page, who);
    await step(page, `${label} > call ${routes.length + shown.length} GET routes`);
    for (const [path, allow] of [...routes, ["/api/hr/payroll-runs/stream", [HR, AC]]]) {
      const status = await statusOf(page, path);
      const allowed = allow === PUBLIC || (who !== "signed_out" && allow.includes(who));
      const refused = status === 401 || status === 403;
      // 0 = still streaming after the headers (an open SSE answer) counts as allowed.
      const pass = allowed ? (!refused && status < 500 && status !== -1) : refused;
      results.push({ who, path, status, expected: allowed ? "allowed" : "refused", pass });
      if (!pass) console.log(`  ⚠ API matrix: ${label} GET ${path} answered ${status}, expected ${allowed ? "an answer (not 401/403/5xx)" : "401/403"}`);
    }
  }

  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  writeFileSync(join(process.cwd(), "test-results", "api-matrix.json"), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n API MATRIX: ${results.length} calls (${routes.length + 1} routes × ${identities.length} identities), ${results.length - failed.length} PASS, ${failed.length} FAIL`);
  expect(failed.map((r) => `${r.who} GET ${r.path} → ${r.status} (expected ${r.expected})`)).toEqual([]);
});
