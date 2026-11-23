// 2026-11-22: "data gone after idle". Reproduced: a slow branch list showed
// "Unknown branch" for everyone, then the real names (the idle check saw those
// lines vanish). And a failed refresh must keep the rows on screen, say so,
// and retry by itself.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { lostLines, main, settle, snapshot } from "../support/portal.mjs";

test("a slow branch list shows a loading cell, never 'Unknown branch'", async ({ page, monitor }) => {
  monitor.at("HR > User Management (slow branches)");
  await page.route("**/api/admin/branches**", async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
  await as(page, "hr", "hr-employees");
  await step(page, "HR > User Management > while the branch names load: no 'Unknown branch'", async () => {
    await expect(main(page).locator("tbody tr").first()).toBeVisible();
    await expect(main(page).getByText("Unknown branch")).toHaveCount(0);
  });
  await step(page, "Once loaded: the same rows and lines after an idle focus change", async () => {
    await settle(page);
    const before = await snapshot(page);
    await page.waitForTimeout(5000);
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    await settle(page);
    const after = await snapshot(page);
    expect(after.rows).toBe(before.rows);
    expect(lostLines(before, after)).toEqual([]);
  });
});

test("a failed refresh keeps the rows, says 'Couldn't refresh, retrying', and recovers by itself", async ({ page, monitor }) => {
  monitor.allow(/^500 GET \/api\/hr\/employees/, /status of 500/);
  await as(page, "hr", "hr-employees");
  await settle(page);
  const before = await snapshot(page);
  expect(before.rows).toBeGreaterThan(0);

  await step(page, "The refresh fails: rows stay, the note shows", async () => {
    await page.route("**/api/hr/employees**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Temporarily unavailable."}' }));
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect(main(page).getByTestId("refresh-failed-note")).toContainText("Couldn't refresh, retrying");
    expect(await page.locator("#portal-main table tbody tr").count()).toBe(before.rows);
  });

  await step(page, "The server is back: the automatic retry clears the note, same rows", async () => {
    await page.unroute("**/api/hr/employees**");
    await expect(main(page).getByTestId("refresh-failed-note")).toHaveCount(0, { timeout: 20000 });
    await settle(page);
    expect(await page.locator("#portal-main table tbody tr").count()).toBe(before.rows);
  });
});
