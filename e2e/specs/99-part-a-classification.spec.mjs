// Part A (panel revisions, 2026-11-20): category, employment status and type.
// HR sees what needs confirming, filters the list, changes a status with a
// date and a reason, and edits the leave and pay rules; the employee sees
// leave credits per type; the Accountant's batch shows the classification.
// The server refuses a silent change and a non-HR writer.
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 E2E_RESET=0 npx playwright test e2e/specs/99-part-a-classification.spec.mjs --project=desktop
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { settle } from "../support/portal.mjs";
import { db } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test.describe.configure({ mode: "serial" });

const OUT = join(process.cwd(), "screenshots", "2026-11-20-part-a");
mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

test("HR: Action needed, Employment column and filters, a dated change, the rules page", async ({ page }) => {
  // One record set by default and waiting for HR (as the migration left the live ones).
  await db().from("profiles").update({ classification_unconfirmed: true }).eq("email", ACCOUNTS.employee2.email);
  await as(page, "hr", "hr-dashboard");
  await settle(page);
  await expect(page.getByText("Action needed")).toBeVisible();
  await expect(page.getByText("Needs HR confirmation").first()).toBeVisible();
  await shot(page, "01-hr-dashboard-action-needed");

  await page.goto("/hr?page=hr-employees&emp_filter=unconfirmed");
  await settle(page);
  await expect(page.locator("thead").getByText("Employment", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs HR confirmation").first()).toBeVisible();
  await shot(page, "02-hr-employees-needs-confirmation");

  // Start from Regular (a rerun after a failed run may have left it Probationary; "already" is fine).
  const before = (await (await page.request.get("/api/hr/employees")).json()).employees.find((e) => e.email === "emp1@e2e.test");
  await page.request.post("/api/hr/employee-classification", {
    data: { employee_id: before.id, changes: { employment_status: "Regular" }, effective_on: today(), reason: "Start of the Part A check" },
  });

  // The 201 record: category / status are read-only; "Change status…" opens the dated change.
  await page.goto("/hr?page=hr-employees");
  await settle(page);
  const row = page.getByRole("row").filter({ hasText: "emp1@e2e.test" });
  await row.getByRole("button", { name: /edit/i }).first().click();
  await expect(page.getByRole("button", { name: "Change status…" })).toBeVisible();
  await shot(page, "03-201-record-locked-fields");
  await page.getByRole("button", { name: "Change status…" }).click();
  const dialog = page.getByRole("dialog", { name: /Category and status/ });
  await expect(dialog.getByText("Leave credits")).toBeVisible();
  await dialog.locator("#cls-employment_status").click();
  await page.getByRole("option", { name: "Probationary" }).click();
  await dialog.locator("#cls-reason").fill("Hired on probation: corrected record");
  await dialog.getByRole("button", { name: "Save change" }).click();
  await expect(dialog.getByText(/Employment status: Regular → Probationary/).first()).toBeVisible();
  await shot(page, "04-change-with-date-and-history");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The rules page.
  await page.goto("/hr?page=hr-classification-rules");
  await settle(page);
  await expect(page.getByText("Leave credits", { exact: true })).toBeVisible();
  await expect(page.getByText("Pending policy manual").first()).toBeVisible();
  await shot(page, "05-status-and-leave-rules");

  // The server: a silent change through the 201 edit is refused.
  const list = await (await page.request.get("/api/hr/employees")).json();
  const emp1 = list.employees.find((e) => e.email === "emp1@e2e.test");
  const silent = await page.request.patch("/api/hr/employees", { data: { ...emp1, employee_type: emp1.employee_type === "Teaching" ? "Non-Teaching" : "Teaching", updated_at: emp1.updated_at } });
  expect(silent.status()).toBe(400);
  expect((await silent.json()).error).toMatch(/Change status/);

  // Put emp1 back for the other specs (Regular from today).
  const back = await page.request.post("/api/hr/employee-classification", {
    data: { employee_id: emp1.id, changes: { employment_status: "Regular" }, effective_on: today(), reason: "Back to Regular after the Part A check" },
  });
  expect(back.ok()).toBe(true);
});

test("Admin cannot change a classification; employee sees leave credits by type", async ({ page }) => {
  await as(page, "admin", "adm-dashboard");
  const refused = await page.request.post("/api/hr/employee-classification", { data: { action: "confirm", employee_id: "00000000-0000-4000-8000-000000000000" } });
  expect(refused.status()).toBe(403);

  // Ana on file as female: maternity shows as statutory leave, paternity does not.
  const ana = (await db().from("profiles").select("id").eq("email", ACCOUNTS.employee.email).single()).data;
  const before = (await db().auth.admin.getUserById(ana.id)).data.user.user_metadata;
  await db().auth.admin.updateUserById(ana.id, { user_metadata: { ...before, sex: "Female" } });
  try {
    await as(page, "employee", "emp-leave");
    await settle(page);
    await expect(page.getByText("This year's leave with pay, by type")).toBeVisible();
    await expect(page.getByText(/of 5 days used/).first()).toBeVisible();
    await expect(page.getByText("Statutory leave, filed per event")).toBeVisible();
    await expect(page.getByText(/Maternity Leave: up to 105 days each time/)).toBeVisible();
    await expect(page.getByText("Paternity Leave")).toHaveCount(0);
    await shot(page, "06-employee-leave-credits-by-type");
  } finally {
    await db().auth.admin.updateUserById(ana.id, { user_metadata: { ...before, sex: before.sex ?? null } });
  }
});

test("Accountant: the batch shows the classification and filters by it", async ({ page }) => {
  await as(page, "accountant", "ac-process");
  await settle(page);
  await expect(page.getByText(/(Teaching|Non-Teaching) · Regular/).first()).toBeVisible();
  // No part-time employees (2026-11-23): the employment type is not shown.
  await expect(page.locator("#portal-main").getByText(/Full-time|Part-time/)).toHaveCount(0);
  await shot(page, "07-batch-classification");
});
