// Access control: signed-out visitors, other roles' portals and APIs a role
// must not reach. Expectations come from the business rules (only the
// Accountant processes payroll, only HR approves it and manages people, the
// Super Admin runs the system but not payroll), not from the code under test.
import { test, expect } from "../support/test.mjs";
import { as, signOutLocally, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { ACCOUNTS, ROLES } from "../accounts.mjs";

const PORTALS = ROLES.map((r) => ACCOUNTS[r].portal);

// [method, path, body?] a role must be refused (401/403).
const FORBIDDEN = {
  employee: [
    ["GET", "/api/accountant/payroll-runs"], ["GET", "/api/hr/payroll-runs"], ["GET", "/api/admin/users"],
    ["GET", "/api/admin/audit-logs"], ["GET", "/api/admin/config"], ["GET", "/api/rfid/cards"],
    ["GET", "/api/hr/leave-requests"], ["GET", "/api/hr/awol-cases"], ["GET", "/api/hr/tenure-protection"],
    ["GET", "/api/hr/payroll-records"], ["GET", "/api/admin/work-schedules"], ["POST", "/api/admin/branches", { name: "x" }],
  ],
  accountant: [
    ["GET", "/api/admin/users"], ["GET", "/api/rfid/cards"], ["GET", "/api/admin/config"], ["GET", "/api/hr/leave-requests"],
    ["GET", "/api/hr/tenure-protection"], ["GET", "/api/admin/audit-logs"], ["GET", "/api/admin/work-schedules"],
    ["PATCH", "/api/hr/payroll-runs", { action: "approve", run_id: "00000000-0000-0000-0000-000000000000" }],
    ["PATCH", "/api/hr/employees", { id: "00000000-0000-0000-0000-000000000000", basic_salary: 1 }],
  ],
  admin: [
    ["GET", "/api/accountant/payroll-runs"], ["GET", "/api/hr/payroll-runs"], ["GET", "/api/admin/users"],
    ["GET", "/api/admin/config"], ["GET", "/api/hr/leave-requests"], ["GET", "/api/hr/tenure-protection"],
    ["GET", "/api/admin/audit-logs"], ["GET", "/api/admin/work-schedules"], ["GET", "/api/hr/payroll-records"],
    ["POST", "/api/accountant/payroll", { action: "process" }],
  ],
  hr: [
    ["GET", "/api/accountant/payroll"], ["POST", "/api/accountant/payroll", { action: "process" }],
    ["GET", "/api/admin/config"], ["GET", "/api/admin/audit-logs"], ["POST", "/api/admin/branches", { name: "x" }],
  ],
  super_admin: [
    ["GET", "/api/accountant/payroll-runs"], ["GET", "/api/accountant/payroll"], ["POST", "/api/accountant/payroll", { action: "process" }],
    ["GET", "/api/hr/payroll-runs"], ["PATCH", "/api/hr/payroll-runs", { action: "approve", run_id: "00000000-0000-0000-0000-000000000000" }],
    ["GET", "/api/hr/leave-requests"], ["GET", "/api/hr/tenure-protection"],
    ["PATCH", "/api/hr/employees", { id: "00000000-0000-0000-0000-000000000000", basic_salary: 1 }],
  ],
};

test("signed out: every portal goes to the login page and the API refuses", async ({ page, monitor }) => {
  monitor.at("Signed out");
  monitor.allow(/^401 /);
  await signOutLocally(page);
  for (const portal of [...PORTALS, "/rfid-terminal"]) {
    await step(page, `Signed out > open ${portal} > expect the login page`);
    await page.goto(portal);
    await expect(page).toHaveURL(/\/login/);
  }
  for (const path of ["/api/hr/employees", "/api/accountant/payroll-runs", "/api/rbac/me", "/api/employee/payslips"]) {
    await step(page, `Signed out > GET ${path} > expect 401`);
    const res = await page.request.get(path);
    expect([401, 403], `${path} answered ${res.status()} with no session`).toContain(res.status());
  }
});

for (const role of ROLES) {
  test(`${ROLE_LABEL[role]}: other portals and forbidden APIs are blocked`, async ({ page, monitor }) => {
    monitor.at(ROLE_LABEL[role]);
    monitor.allow(/^40[13] /);
    await as(page, role);
    for (const portal of PORTALS.filter((p) => p !== ACCOUNTS[role].portal)) {
      await step(page, `${ROLE_LABEL[role]} > open ${portal} > expect to stay in ${ACCOUNTS[role].portal}`);
      await page.goto(portal);
      await page.waitForURL((url) => url.pathname.startsWith(ACCOUNTS[role].portal), { timeout: 30000 }).catch(() => {});
      const path = new URL(page.url()).pathname;
      expect(path.startsWith(ACCOUNTS[role].portal), `${ROLE_LABEL[role]} reached ${portal} (now at ${path})`).toBe(true);
    }
    for (const [method, path, body] of FORBIDDEN[role]) {
      await step(page, `${ROLE_LABEL[role]} > ${method} ${path} > expect 403`);
      const res = await page.request.fetch(path, { method, data: body, headers: body ? { "Content-Type": "application/json" } : {} });
      expect([401, 403], `${ROLE_LABEL[role]} ${method} ${path} answered ${res.status()}`).toContain(res.status());
    }
  });
}
