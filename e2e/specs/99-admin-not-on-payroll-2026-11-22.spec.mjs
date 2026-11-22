// 2026-11-22 (user decision): Admin and Super Admin are not on payroll. The
// Add staff account form hides date hired / salary / tenure for them; the
// server saves them not on payroll with no date hired. HR still needs one.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { archiveTestAccount, db, profileByEmail, retireAccountsCreatedSince, rows } from "../support/db.mjs";
import { BRANCH_NORTH } from "../accounts.mjs";

let SPEC_START = null;
test.beforeAll(() => { SPEC_START = new Date(Date.now()).toISOString(); });
const stamp = Date.now().toString(36).slice(-5);
const letters = stamp.replace(/\d/g, (d) => "abcdefghij"[d]);
const ADMIN = { email: `not.payroll.${stamp}@e2e.test`, last: `Offpay${letters.charAt(0).toUpperCase()}${letters.slice(1)}` };
test.afterAll(async () => { await archiveTestAccount(ADMIN.email); await retireAccountsCreatedSince(SPEC_START); });

test("Admin accounts: no date hired asked, saved not on payroll; HR still needs a date hired", async ({ page, monitor }) => {
  monitor.allow(/^400 POST \/api\/admin\/staff-accounts/, /status of 400/);
  const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH).single())).id;
  await as(page, "super_admin", "sa-accounts");

  await step(page, "Super Admin > Add staff account > role Admin: the date hired field is replaced by the not-on-payroll note", async () => {
    await main(page).getByRole("button", { name: "Add staff account" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/Date hired/)).toBeVisible();
    await dialog.locator("#sa-add-role").click();
    await page.getByRole("option", { name: "Admin", exact: true }).click();
    await expect(dialog.getByTestId("not-on-payroll-note")).toContainText("not on payroll");
    await expect(dialog.getByLabel(/Date hired/)).toHaveCount(0);
    await expect(dialog.getByLabel(/Basic salary/)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  const body = {
    first_name: "Odette", last_name: ADMIN.last, email: ADMIN.email, role: "admin", branch_id: north, employee_status: "Active",
    date_of_birth: "1990-05-05", sex: "Female", civil_status: "Single", cp_number: "09171234561",
    address: "12 Rizal St, Pasig City", emergency_contact_name: "Maria Probe", emergency_contact_relationship: "Parent",
    emergency_contact_number: "09181234561", emergency_contact_address: "45 Rizal Ave, Pasig City",
  };

  await step(page, "HR without a date hired is refused (still on payroll)", async () => {
    const res = await api(page, "POST", "/api/admin/staff-accounts", { ...body, email: `x.${ADMIN.email}`, role: "hr", branch_id: "", basic_salary: 25000, employment_status: "Regular", employment_type: "Full-time" });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/date hired/i);
  });

  await step(page, "Admin without a date hired is created: not on payroll, no date hired", async () => {
    const res = await api(page, "POST", "/api/admin/staff-accounts", body);
    expect([200, 201], JSON.stringify(res.data)).toContain(res.status);
    const saved = await profileByEmail(ADMIN.email);
    expect(saved.on_payroll).toBe(false);
    expect(saved.date_hired).toBeNull();
  });
});
