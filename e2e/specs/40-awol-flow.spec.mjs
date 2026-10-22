// AWOL and incidents: the branch Admin files a no-show report, it lands in
// HR's AWOL Cases, HR handles it (confirms, then closes it), and the Admin
// sees the status but cannot decide it.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { choose, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const NOTE = `E2E no-show, not reachable by phone ${Date.now()}`;

test("AWOL: admin files a no-show → HR AWOL case → HR confirms and closes → admin sees it", async ({ page, monitor }) => {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);

  await step(page, "Admin > Incident & AWOL Reports > send an empty report (refused)", async () => {
    monitor.at("Admin > Incident & AWOL Reports");
    await as(page, "admin", "adm-incidents");
    await main(page).getByRole("button", { name: "File a report" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Send to HR" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[role="alert"], .text-destructive').first()).toBeVisible();
  });

  await step(page, "Admin > Incident & AWOL Reports > file a no-show for Bea", async () => {
    const dialog = page.getByRole("dialog");
    await choose(page, dialog.locator("#ov-employee_id"), /Bea/);
    await dialog.locator("#ov-note").fill(NOTE);
    await dialog.getByRole("button", { name: "Send to HR" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: "Bea" }).filter({ hasText: NOTE }).first()).toBeVisible();
    // The Admin files; it cannot close or decide.
    await expect(main(page).getByRole("button", { name: /Close|Confirm AWOL|Separate/ })).toHaveCount(0);
  });

  await step(page, "HR > AWOL Cases > the report is a flagged case", async () => {
    monitor.at("HR > AWOL Cases");
    await as(page, "hr", "hr-awol");
    await settle(page);
    const cases = await rows(db().from("employee_awol_cases").select("id,stage").eq("employee_id", bea.id).order("created_at", { ascending: false }).limit(1));
    expect(cases, "a case reached HR's queue").toHaveLength(1);
    await expect(main(page).locator("tr", { hasText: "Bea" }).first()).toBeVisible();
  });

  await step(page, "HR > AWOL Cases > Confirm AWOL", async () => {
    const row = main(page).locator("tr", { hasText: "Bea" }).first();
    await row.getByRole("button", { name: "Confirm AWOL" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#hr-awol-note").fill("E2E: called twice and the emergency contact; no answer");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: "Bea" }).first().getByRole("button", { name: "Send 1st notice" })).toBeVisible();
  });

  await step(page, "HR > AWOL Cases > Close the case (employee returned)", async () => {
    const row = main(page).locator("tr", { hasText: "Bea" }).first();
    await row.getByRole("button", { name: "Close" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#hr-awol-note").fill("E2E: employee returned with a medical certificate");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await refresh(page);
    const latest = await rows(db().from("employee_awol_cases").select("stage").eq("employee_id", bea.id).order("created_at", { ascending: false }).limit(1));
    expect(latest[0].stage).toBe("closed");
  });

  await step(page, "Admin > Incident & AWOL Reports > status updated, still listed", async () => {
    monitor.at("Admin > Incident & AWOL Reports (after HR)");
    await as(page, "admin", "adm-incidents");
    await expect(main(page).locator("tr", { hasText: NOTE }).first()).toBeVisible();
    await expect(main(page).locator("tr", { hasText: NOTE }).first().getByText("In HR's AWOL Cases")).toBeVisible();
  });
});
