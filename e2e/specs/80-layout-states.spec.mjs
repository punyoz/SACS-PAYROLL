// Every page per role at phone width in dark mode (no sideways page scroll,
// dark theme applied), and each list's loading and error states: the data
// APIs are slowed down, then made to fail, and the page must show a loading
// indicator, then an error with no crash or blank screen.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { PAGES, expectHealthy, main, pageOverflow, settle } from "../support/portal.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const SHOTS = join(process.cwd(), "test-results", "screens");
// Session and shell calls keep working; everything else is page data.
const SHELL = /\/api\/(rbac\/me|legacy-auth\/|notifications|health|dev\/)/;
// Pages that show the signed-in person from the session (no list to load).
const SESSION_ONLY = /-profile$/;
// Pages that load nothing until Generate: the failure must show after it.
const ON_DEMAND = { "emp-timesheet": "Generate", "hr-reports": "Generate", "ac-reports": null };

for (const role of Object.keys(PAGES)) {
  test(`${ROLE_LABEL[role]}: every page at phone width in dark mode`, async ({ page, monitor }) => {
    mkdirSync(SHOTS, { recursive: true });
    await as(page, role);
    await page.evaluate(() => localStorage.setItem("sacs-ui-theme", "dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [id, label] of PAGES[role]) {
      const where = `${ROLE_LABEL[role]} > ${label} (mobile, dark)`;
      monitor.at(where);
      await step(page, where, async () => {
        await page.goto(`${ACCOUNTS[role].portal}?page=${id}`);
        await main(page).waitFor();
        expect(await settle(page), `${where}: still loading`).toBe(true);
        await expectHealthy(page, where);
        expect(await page.evaluate(() => document.body.classList.contains("dark")), `${where}: dark theme not applied`).toBe(true);
        expect(await pageOverflow(page), `${where}: the page scrolls sideways`).toBeLessThanOrEqual(1);
        await page.screenshot({ path: join(SHOTS, `${role}-${id}-mobile-dark.png`), fullPage: true });
      });
    }
    await page.evaluate(() => localStorage.removeItem("sacs-ui-theme"));
  });

  test(`${ROLE_LABEL[role]}: loading and error states of every page`, async ({ page, monitor }) => {
    mkdirSync(SHOTS, { recursive: true });
    monitor.allow(/^503 /, /status of 503/, /E2E simulated outage/);
    await as(page, role);
    for (const [id, label] of PAGES[role]) {
      const where = `${ROLE_LABEL[role]} > ${label}`;
      monitor.at(`${where} (states)`);
      const url = `${ACCOUNTS[role].portal}?page=${id}`;

      await step(page, `${where} > slow API: a loading indicator shows`, async () => {
        let delayed = 0;
        await page.route("**/api/**", async (route) => {
          if (SHELL.test(route.request().url()) || route.request().method() !== "GET") return route.continue();
          delayed += 1;
          await new Promise((r) => setTimeout(r, 3000));
          return route.continue().catch(() => {});
        });
        await page.goto(url);
        await main(page).waitFor();
        await page.waitForTimeout(600);
        const busy = await page.locator('#portal-main [data-slot="skeleton"], #portal-main [aria-busy="true"], #portal-main .animate-spin').count()
          + await main(page).getByText(/Loading/i).count();
        if (delayed && !SESSION_ONLY.test(id) && !(id in ON_DEMAND)) expect.soft(busy, `${where}: no loading indicator while its data loads`).toBeGreaterThan(0);
        await settle(page, 30000);
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });

      await step(page, `${where} > failing API: an error shows, no crash`, async () => {
        let failed = 0;
        await page.route("**/api/**", (route) => {
          if (SHELL.test(route.request().url()) || route.request().method() !== "GET") return route.continue();
          failed += 1;
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "E2E simulated outage" }) });
        });
        await page.goto(url);
        await main(page).waitFor();
        expect(await settle(page), `${where}: spins forever when the API fails`).toBe(true);
        const text = await main(page).innerText();
        expect(text.trim().length, `${where}: blank when the API fails`).toBeGreaterThan(10);
        if (ON_DEMAND[id]) {
          await main(page).getByRole("button", { name: ON_DEMAND[id], exact: true }).click();
          await settle(page);
        }
        if (failed && !SESSION_ONLY.test(id)) {
          const shown = await page.locator('#portal-main [role="alert"]').count()
            + await main(page).getByText(/Something went wrong|E2E simulated outage|Unable to|Could not|Failed to|couldn.t|try again/i).count()
            + await page.locator("[data-sonner-toast]").count();
          expect.soft(shown, `${where}: the failure is not shown to the user`).toBeGreaterThan(0);
          if (!shown) await page.screenshot({ path: join(SHOTS, `${role}-${id}-api-failure.png`), fullPage: true });
        }
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }
  });
}
