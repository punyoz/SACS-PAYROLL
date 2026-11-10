// G9.1 (2026-11-09): ONE headless click-through of the live flow on the LOCAL
// demo data: Branch 2's Accountant reprocesses and resubmits the cutoff HR
// rejected, HR One approves it, and an Employee of Branch 2 opens the payslip.
// It changes data: run it on a snapshot you restore afterwards.
//   npx playwright test -c playwright.demo.config.mjs --project=live --workers=1
import { test, expect } from "@playwright/test";
import { plantOtp } from "../support/db.mjs";
import { TEST_OTP } from "../accounts.mjs";
import { credentials } from "./roles.mjs";

const PERIOD = "October 16-31, 2026";

async function signIn(page, tag, portal) {
  const { email, password } = credentials()[tag];
  await plantOtp(email);
  await page.goto("/login");
  await page.fill("#login-identity", email);
  await page.fill("#login-password", password);
  await page.locator("form button[type=submit]").first().click();
  await expect(page.getByText("Check your email")).toBeVisible({ timeout: 30000 });
  await page.locator("#login-code").click();
  await page.keyboard.type(TEST_OTP);
  await page.waitForURL((url) => url.pathname.startsWith(portal), { timeout: 60000 });
  await page.locator("#portal-main").waitFor();
}

test("Accountant processes, HR approves, Employee sees the payslip", async ({ browser }) => {
  test.setTimeout(240000);
  // 1. Accountant (Branch 2): process the cutoff HR sent back, then resubmit it.
  const acc = await (await browser.newContext()).newPage();
  await signIn(acc, "acc-b2-1", "/accountant");
  await acc.goto(`/accountant?page=ac-process&period=${encodeURIComponent(PERIOD)}`);
  await acc.getByRole("button", { name: "Process payroll for all →" }).click();
  const confirmProcess = acc.getByRole("alertdialog").or(acc.getByRole("dialog")).getByRole("button", { name: /Process|Confirm|Continue/ }).last();
  if (await confirmProcess.isVisible().catch(() => false)) await confirmProcess.click();
  await expect(acc.getByRole("button", { name: "Process payroll for all →" })).toBeEnabled({ timeout: 60000 });
  await acc.getByRole("button", { name: "Resubmit for HR Approval" }).click();
  await acc.getByRole("alertdialog").or(acc.getByRole("dialog")).getByRole("button", { name: "Resubmit" }).click();
  await expect(acc.getByText(/Locked until HR decides/)).toBeVisible({ timeout: 30000 });

  // 2. HR One (no payslip in Branch 2's run): approve it.
  const hr = await (await browser.newContext()).newPage();
  await signIn(hr, "hr1", "/hr");
  await hr.goto("/hr?page=hr-payroll-approval");
  const row = hr.locator("#portal-main tr, #portal-main [data-slot=data-table-card]").filter({ hasText: /Spring Valley/ }).filter({ hasText: PERIOD }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.getByRole("button", { name: "Review" }).click();
  await hr.locator("#portal-main").getByRole("button", { name: "Approve", exact: true }).first().click();
  await hr.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(hr.getByText(/Approved by Demo HR One/).first()).toBeVisible({ timeout: 30000 });

  // 3. An Employee of Branch 2 opens My Payslips: the approved payslip is there.
  const emp = await (await browser.newContext()).newPage();
  await signIn(emp, "emp9", "/employee");
  await emp.goto("/employee?page=emp-payslips");
  await expect(emp.locator("#portal-main").getByText(PERIOD).first()).toBeVisible({ timeout: 30000 });
  // No employer-share amount on any employee view (a help note may say "there is no employer share").
  await expect(emp.locator("#portal-main")).not.toContainText(/Employer (share|contribution)s?:?\s*₱|SSS ER\b|\bER share/i);
});
