// 2026-11-08 batch on a phone (390x844, touch): toolbars stack (search on
// top, filters underneath, swipeable, 40 px targets), long dropdowns open as
// a bottom sheet with the search box at the top, toasts at the top full
// width, the rates pair and the backup page fit, no sideways page scroll.
//
//   E2E_SLOWMO=500 npx playwright test e2e/mobile/m3-ui-2026-11-08.spec.mjs --project=mobile
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle, pageOverflow } from "../support/portal.mjs";

const SHOTS = join(process.cwd(), "screenshots", "2026-11-08", "after-mobile");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

const results = [];
function check(where, ok, text) {
  results.push({ where, ok, text });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${where}: ${text}`);
  return ok;
}

test("2026-11-08 on a phone: toolbars, dropdown sheets, toasts, rates, backup", async ({ page, monitor }) => {
  monitor.allow(/^401 GET /, /status of 401/);
  const W = page.viewportSize().width;

  await step(page, "Toolbars stack: search full width on top, filters underneath", async () => {
    for (const [role, pageId] of [["super_admin", "sa-accounts"], ["super_admin", "sa-maintenance"], ["hr", "hr-employees"], ["hr", "hr-tenure"], ["accountant", "ac-monitoring"], ["admin", "adm-leaves"]]) {
      await as(page, role, pageId);
      await settle(page);
      const bar = main(page).locator('[data-slot="table-toolbar"]:has([data-slot="table-toolbar-tools"])').first();
      await bar.scrollIntoViewIfNeeded();
      const search = await bar.locator('input[type="search"]').boundingBox();
      const tools = await bar.locator('[data-slot="table-toolbar-tools"]').boundingBox();
      const tab = await bar.locator('[role="tab"]').first().boundingBox();
      check(pageId, search.y + search.height <= tools.y + 1 && search.width >= W - 120, `search on top (${Math.round(search.width)} px wide), filters below`);
      check(pageId, !tab || tab.height >= 40, `tab target ${Math.round(tab?.height || 0)} px tall`);
      check(pageId, search.height >= 40, `search box ${Math.round(search.height)} px tall`);
      check(pageId, (await pageOverflow(page)) <= 0, "no sideways page scroll");
      await shot(page, `toolbar-${pageId}`);
    }
  });

  await step(page, "Add Branch: Region and Barangay open as a bottom sheet with search on top", async () => {
    await as(page, "super_admin", "sa-branches");
    await settle(page);
    await main(page).getByRole("button", { name: "Add branch" }).click();
    const dialog = page.getByRole("dialog").first();
    await dialog.locator("#sa-branch-region").click();
    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(700); // the slide-up animation
    const box = await sheet.boundingBox();
    const search = await sheet.getByRole("searchbox").boundingBox();
    const list = await sheet.getByRole("listbox").boundingBox();
    check("Region sheet", box.y + box.height <= 844 + 1 && box.width >= W - 2, `bottom sheet, full width (${Math.round(box.width)}), on screen (${Math.round(box.y)}–${Math.round(box.y + box.height)} of 844)`);
    check("Region sheet", search.y < list.y, "search box above the list");
    await shot(page, "region-sheet");
    await sheet.getByRole("searchbox").fill("calabarzon");
    await sheet.getByRole("option").first().click();
    await dialog.locator("#sa-branch-province").click();
    await page.locator('[data-slot="sheet-content"]').getByRole("searchbox").fill("rizal");
    await page.locator('[data-slot="sheet-content"]').getByRole("option", { name: /^Rizal$/ }).click();
    await dialog.locator("#sa-branch-city").click();
    await page.locator('[data-slot="sheet-content"]').getByRole("searchbox").fill("antipolo");
    await page.locator('[data-slot="sheet-content"]').getByRole("option", { name: /Antipolo/ }).first().click();
    await dialog.locator("#sa-branch-barangay").click();
    const bSheet = page.locator('[data-slot="sheet-content"]');
    await bSheet.getByRole("searchbox").fill("zzzz");
    check("Barangay sheet", await bSheet.getByText("No results").isVisible(), "no match: No results");
    await bSheet.getByRole("searchbox").fill("dela");
    await shot(page, "barangay-sheet");
    await bSheet.getByRole("option").first().click();
    check("Cascade", !/Select barangay/.test(await dialog.locator("#sa-branch-barangay").innerText()), "barangay chosen on the phone");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  await step(page, "Toasts: top of the screen, full width with side margins, under the header", async () => {
    await as(page, "accountant", "ac-reports");
    await settle(page);
    // Reports load by themselves now (alpha test B4): the toast comes from
    // asking for the payroll sheet with no single period chosen.
    await main(page).locator("#rpt-type").click();
    await page.getByRole("option", { name: "Payroll sheet (school format)" }).click();
    await main(page).getByRole("button", { name: "Refresh report" }).click();
    const toast = page.locator('[data-sonner-toast][data-mounted="true"]').first();
    await toast.waitFor();
    await page.waitForTimeout(700);
    const box = await toast.boundingBox();
    check("Toast", box.y >= 56 && box.x >= 8 && box.x + box.width <= W - 8 && box.width >= W - 40, `y=${Math.round(box.y)}, x=${Math.round(box.x)}, width ${Math.round(box.width)} of ${W}`);
    await shot(page, "toast-accountant");
  });

  await step(page, "Rates and backup pages fit the phone", async () => {
    await as(page, "super_admin", "sa-config");
    await settle(page);
    await main(page).getByRole("tab", { name: "Rates" }).click();
    await settle(page);
    const pair = main(page).locator('[data-testid="rate-pair"]');
    await pair.scrollIntoViewIfNeeded();
    for (const id of ["daily-current", "hourly-current", "daily-next", "hourly-next"]) {
      check("Rates", await pair.locator(`[data-testid="${id}"]`).isVisible(), `${id} visible`);
    }
    check("Rates", (await pageOverflow(page)) <= 0, "no sideways page scroll");
    await shot(page, "rates-pair");
    await as(page, "super_admin", "sa-backup");
    await settle(page);
    await main(page).locator('[data-testid="full-backup"]').scrollIntoViewIfNeeded();
    check("Backup", (await pageOverflow(page)) <= 0, "no sideways page scroll");
    await shot(page, "backup-page");
    await as(page, "admin", "adm-pay-rates");
    await settle(page);
    check("Admin pay rates", (await pageOverflow(page)) <= 0, "no sideways page scroll");
    await shot(page, "admin-pay-rates");
  });

  writeFileSync(join(SHOTS, "..", "mobile-results.json"), JSON.stringify(results, null, 2));
  expect(results.filter((r) => !r.ok).map((r) => `${r.where}: ${r.text}`)).toEqual([]);
});
