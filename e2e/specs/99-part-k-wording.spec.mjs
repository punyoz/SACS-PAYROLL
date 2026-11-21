// Part K (panel revisions, 2026-11-21): one word per thing on screen. HR's
// own attendance change is "Override"; run statuses read Pending HR approval /
// Returned by HR / Paid / Draft / Ready for HR; "Pay on hold", "No tap yet",
// "Category", "13th month pay". Screenshots for the review.
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test e2e/specs/99-part-k-wording.spec.mjs --project=desktop
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";

const OUT = join(process.cwd(), "screenshots", "2026-11-21-part-k");
mkdirSync(OUT, { recursive: true });
const shot = (page, name, target = page) => target.screenshot({ path: join(OUT, `${name}.png`), ...(target === page ? { fullPage: true } : {}) });

test("HR: Override on attendance, No tap yet, run statuses", async ({ page }) => {
  await as(page, "hr", "hr-dashboard");
  await settle(page);
  await expect(main(page).getByText("No tap yet").first()).toBeVisible();
  await expect(main(page).getByText("Not yet recorded")).toHaveCount(0);
  await shot(page, "01-hr-dashboard-no-tap-yet");

  await as(page, "hr", "hr-attendance");
  await settle(page);
  await expect(main(page).getByRole("button", { name: "Correct", exact: true })).toHaveCount(0);
  const override = main(page).getByRole("button", { name: "Override", exact: true }).first();
  await expect(override).toBeVisible();
  await shot(page, "02-hr-attendance-override-button");
  await override.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Override attendance")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save override" })).toBeVisible();
  await dialog.locator("#att-correct-type").click();
  await expect(page.getByRole("option", { name: /^Override time in/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Override both time in and time out/ })).toBeVisible();
  await shot(page, "03-override-dialog-options");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await as(page, "hr", "hr-payroll-approval");
  await settle(page);
  await expect(page.getByRole("tab", { name: /Pending HR approval/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Returned by HR/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Rejected by HR|Pending HR Approval/ })).toHaveCount(0);
  await shot(page, "04-hr-payroll-approval-tabs");
});

test("Accountant: monitoring statuses, 13th month pay, Category filter", async ({ page }) => {
  await as(page, "accountant", "ac-monitoring");
  await settle(page);
  for (const word of ["Ready for HR", "Pending HR approval", "Returned by HR", "Pay on hold"]) {
    await expect(main(page).getByText(word, { exact: true }).first()).toBeVisible();
  }
  await expect(main(page).getByText(/Not submitted to HR|Rejected by HR/)).toHaveCount(0);
  await shot(page, "05-accountant-monitoring-statuses");
  await as(page, "accountant", "ac-13th");
  await settle(page);
  await expect(page.locator("header").getByText("13th month pay").first()).toBeVisible();
  await expect(page.getByText("13th Month Pay", { exact: true })).toHaveCount(0);

  await as(page, "accountant", "ac-process");
  await settle(page);
  await expect(main(page).getByLabel("Category").first()).toBeVisible();
  await shot(page, "06-accountant-process-category-filter");
});

test("Employee: Category on the profile", async ({ page }) => {
  await as(page, "employee", "emp-profile");
  await settle(page);
  await expect(main(page).getByText("Category", { exact: true }).first()).toBeVisible();
  await expect(main(page).getByText("Employee type", { exact: true })).toHaveCount(0);
  await shot(page, "07-employee-profile-category");
});
