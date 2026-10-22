// Licensed-teacher subsidy, end to end: the Super Admin sets the subsidy, HR
// turns on and verifies Ana's license, the Accountant processes a
// missed-month adjustment, HR rejects it with a reason, the Accountant fixes
// and resubmits, HR approves, and the Decision history keeps every step.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { choose, pickDate, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const REJECT = "E2E: the months missed were Aug-Sep, not Sep only";

const latestRequest = async (employeeId) => (await rows(db().from("payroll_subsidy_requests").select("id,status").eq("employee_id", employeeId).order("created_at", { ascending: false }).limit(1)))[0];

test("subsidy: SA sets it → HR licenses → Accountant processes → HR rejects → resubmit → HR approves → history", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);

  await step(page, "Super Admin > System Configuration > Payroll > Licensed Teacher Subsidy", async () => {
    monitor.at("Super Admin > Teacher Subsidy");
    await as(page, "super_admin", "sa-config");
    await page.getByRole("tab", { name: "Payroll" }).click();
    await settle(page);
    await main(page).locator("#sub-amount").fill("12000");
    await main(page).locator("#sub-note").fill("E2E: school subsidy policy");
    await main(page).getByRole("button", { name: "Save settings" }).click();
    const confirmDialog = page.locator('[role="alertdialog"]:visible');
    if (await confirmDialog.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) {
      await confirmDialog.getByRole("button").last().click();
    }
    await expect.poll(async () => (await rows(db().from("payroll_subsidy_settings").select("id"))).length, { timeout: 20000 }).toBeGreaterThan(0);
  });

  await step(page, "HR > User Management > Edit Ana > turn on Licensed teacher", async () => {
    monitor.at("HR > User Management > license");
    await as(page, "hr", "hr-employees");
    await main(page).locator("tr", { hasText: "Ana" }).first().getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#emp-license-switch").click();
    await dialog.locator("#emp-license-no").fill("0123456");
    await pickDate(page, dialog.locator("#emp-license-exp"), "2029-06-30");
    await dialog.locator("#emp-license-reason").fill("E2E: PRC license submitted");
    await dialog.getByRole("button", { name: "Save license" }).click();
    await expect(dialog.getByRole("button", { name: "Verify license" })).toBeVisible({ timeout: 30000 });
  });

  await step(page, "HR > User Management > Edit Ana > Verify license", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Verify license" }).click();
    await dialog.locator("#emp-license-pending").fill("E2E: checked on the PRC site");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await rows(db().from("payroll_subsidy_balances").select("id").eq("employee_id", ana.id))).length, { timeout: 30000 }).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
  });

  await step(page, "Accountant > Subsidies > Process adjustment with no teacher (refused)", async () => {
    monitor.at("Accountant > Subsidies");
    // The server refuses the empty request (400) and the dialog says why.
    monitor.allow(/^400 POST \/api\/admin\/approvals/, /status of 400/);
    await as(page, "accountant", "ac-approvals");
    await main(page).getByRole("button", { name: "Process adjustment" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Process and send to HR" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[role="alert"], .text-destructive').first()).toBeVisible();
    expect(await latestRequest(ana.id)).toBeUndefined();
    monitor.clearAllowed();
  });

  await step(page, "Accountant > Subsidies > Process a missed-month adjustment for Ana", async () => {
    const dialog = page.getByRole("dialog");
    await choose(page, dialog.locator("#sb-bal"), /Ana/);
    await dialog.locator("#sb-months").fill("1");
    await dialog.locator("#sb-label").fill("Sep 2026");
    await dialog.locator("#sb-amount").fill("1000");
    await dialog.locator("#sb-reason").fill("E2E: license valid since Sep 1; verification delayed");
    await dialog.getByRole("button", { name: "Process and send to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    expect((await latestRequest(ana.id)).status).toBe("processed");
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: "Ana" }).first()).toBeVisible();
  });

  await step(page, "HR > Subsidy Approvals > Reject with a reason", async () => {
    monitor.at("HR > Subsidy Approvals");
    await as(page, "hr", "hr-subsidy-approvals");
    await main(page).locator("tr", { hasText: "Ana" }).first().getByRole("button", { name: "Reject" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toBeVisible();
    await dialog.locator("#sb-note").fill(REJECT);
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    expect((await latestRequest(ana.id)).status).toBe("rejected");
  });

  await step(page, "Accountant > Subsidies > sees the reason, Fix & resubmit", async () => {
    monitor.at("Accountant > Subsidies (resubmit)");
    await as(page, "accountant", "ac-approvals");
    await expect(main(page).getByText(REJECT).first()).toBeVisible();
    await main(page).locator("tr", { hasText: "Ana" }).first().getByRole("button", { name: "Fix & resubmit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#sb-months").fill("2");
    await dialog.locator("#sb-label").fill("Aug–Sep 2026");
    await dialog.locator("#sb-amount").fill("2000");
    await dialog.getByRole("button", { name: "Resubmit to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    expect((await latestRequest(ana.id)).status).toBe("processed");
  });

  await step(page, "HR > Subsidy Approvals > Approve", async () => {
    monitor.at("HR > Subsidy Approvals (approve)");
    await as(page, "hr", "hr-subsidy-approvals");
    await main(page).locator("tr", { hasText: "Ana" }).first().getByRole("button", { name: "Approve" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#sb-note").fill("E2E: approved after correction");
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    expect(["approved", "applied"]).toContain((await latestRequest(ana.id)).status);
  });

  await step(page, "HR > Subsidy Approvals > Decision history keeps reject and approve (after refresh)", async () => {
    await refresh(page);
    const history = main(page).locator("div", { has: page.getByText("Decision history") }).last();
    await expect(main(page).getByText(REJECT).first()).toBeVisible();
    await expect(history.getByText(/approved after correction/).first()).toBeVisible();
  });

  await step(page, "Accountant > Subsidies > Approved, same history", async () => {
    monitor.at("Accountant > Subsidies (after approval)");
    await as(page, "accountant", "ac-approvals");
    await expect(main(page).locator("tr", { hasText: "Ana" }).filter({ hasText: /Approved|Applied/ }).first()).toBeVisible();
    await expect(main(page).getByText(REJECT).first()).toBeVisible();
  });
});
