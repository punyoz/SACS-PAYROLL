/**
 * Offboarding ends the role at once (2026-11-21, fix a): a separated HR
 * account's next HR request is refused, while its own payslips (final pay
 * included) and profile still open until the account is archived.
 */
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api } from "../support/flow.mjs";
import { archiveTestAccount, profileByEmail, psql, retireAccountsCreatedSince } from "../support/db.mjs";
import { sessionCookie } from "../../scripts/demo/local-api.mjs";

let SPEC_START = null;
test.beforeAll(() => { SPEC_START = new Date(Date.now()).toISOString(); });

const stamp = Date.now().toString(36);
const letters = stamp.replace(/[^a-z]/g, "") || "x";
const STAFF = { email: `separated.hr.${stamp}@e2e.test`, last: `Leaver${letters.charAt(0).toUpperCase()}${letters.slice(1)}` };
test.afterAll(async () => { await archiveTestAccount(STAFF.email); await retireAccountsCreatedSince(SPEC_START); });

test("offboarded HR: the next HR request is refused, My Payslips and My Profile still open", async ({ page, monitor }) => {
  monitor.allow(/^403 /, /status of 403/);
  let cookie;
  const asStaff = async (path) => {
    const res = await page.request.get(path, { headers: { cookie, "x-sacs-background": "1" } });
    return { status: res.status(), text: await res.text() };
  };

  await step(page, "Super Admin > creates a throwaway HR account", async () => {
    monitor.at("Super Admin > Admin & HR Accounts");
    await as(page, "super_admin", "sa-accounts");
    const made = await api(page, "POST", "/api/admin/staff-accounts", {
      first_name: "Lena", last_name: STAFF.last, email: STAFF.email, role: "hr", employee_status: "Active",
      date_of_birth: "1990-05-05", date_hired: "2024-01-01", sex: "Female", civil_status: "Single", cp_number: "09171234561",
      address: "12 Rizal St, Pasig City", emergency_contact_name: "Maria Probe", emergency_contact_relationship: "Parent",
      emergency_contact_number: "09181234561", emergency_contact_address: "45 Rizal Ave, Pasig City",
      basic_salary: 25000, employment_status: "Regular", employment_type: "Full-time",
    });
    expect([200, 201], JSON.stringify(made.data)).toContain(made.status);
  });

  const staff = await profileByEmail(STAFF.email);
  cookie = await sessionCookie({ id: staff.id, role: "hr", email: staff.email, full: staff.full_name });

  await step(page, "HR (new account) > Employees and My Payslips open while active", async () => {
    expect((await asStaff("/api/hr/employees")).status).toBe(200);
    expect((await asStaff(`/api/me/payslips?email=${encodeURIComponent(staff.email)}`)).status).toBe(200);
  });

  // The app has no "separate" action for an HR login (HR > Offboard covers
  // Employee and Accountant; the Super Admin archives HR logins), so the
  // status an offboarding writes is set directly here.
  await step(page, "HR account > marked Separated (as an offboarding records it)", async () => {
    psql(`update profiles set employee_status = 'Separated' where id = '${staff.id}'`);
    expect((await profileByEmail(STAFF.email)).employee_status).toBe("Separated");
  });

  await step(page, "HR (separated) > the very next HR request is refused; own payslips and profile still open", async () => {
    const hr = await asStaff("/api/hr/employees");
    expect(hr.status, hr.text).toBe(403);
    expect(hr.text).toMatch(/separated/i);
    const mine = await asStaff(`/api/me/payslips?email=${encodeURIComponent(staff.email)}`);
    expect(mine.status, mine.text).toBe(200);
    const profile = await asStaff("/api/legacy-auth/update-profile");
    expect(profile.status, profile.text).toBe(200);
    expect((await asStaff("/api/me/timesheet")).status).toBe(403);
  });
});
