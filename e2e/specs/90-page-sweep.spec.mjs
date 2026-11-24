// Every role, every sidebar page and sub-tab: it loads, survives a refresh
// and a round trip to another page with the same data, and no control on it
// throws. Runs last so the business flows have filled the lists.
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { MOVED_PAGES, PAGES, expectHealthy, lostLines, main, navTo, settle, snapshot } from "../support/portal.mjs";
import { exerciseControls } from "../support/controls.mjs";

// Old page links (bookmarks, notifications) land on the page that replaced them.
for (const [role, moved] of Object.entries(MOVED_PAGES)) {
  test(`${ROLE_LABEL[role]}: moved page links redirect`, async ({ page, monitor }) => {
    await as(page, role);
    const portal = role === "super_admin" ? "/super-admin" : `/${role}`;
    for (const [from, to] of Object.entries(moved)) {
      monitor.at(`${ROLE_LABEL[role]} > ${from}`);
      await page.goto(`${portal}?page=${from}`);
      await main(page).waitFor();
      await expect(page).toHaveURL(new RegExp(`page=${to}(&|$)`));
      expect(await settle(page), `${from}: still loading`).toBe(true);
      await expectHealthy(page, `${ROLE_LABEL[role]} > ${from} → ${to}`);
    }
  });
}

for (const role of Object.keys(PAGES)) {
  test.describe(`${ROLE_LABEL[role]} pages`, () => {
    for (const [id, label] of PAGES[role]) {
      test(`${label} (${id})`, async ({ page, monitor }) => {
        const where = `${ROLE_LABEL[role]} > ${label}`;
        monitor.at(where);
        await as(page, role);
        const home = PAGES[role][0][1];

        await step(page, `${where} > open from the sidebar`, async () => {
          await navTo(page, label);
          await expect(page).toHaveURL(new RegExp(`page=${id}`));
          expect(await settle(page), `${where}: still loading after 25 s`).toBe(true);
          await expectHealthy(page, where);
        });
        const first = await snapshot(page);

        await step(page, `${where} > refresh`, async () => {
          await page.reload();
          await main(page).waitFor();
          expect(await settle(page), `${where}: still loading after refresh`).toBe(true);
          // Filters apply after a short pause (Payroll Reports: 250 ms): let them finish.
          await page.waitForTimeout(500);
          await settle(page);
          await expectHealthy(page, `${where} (after refresh)`);
          const again = await snapshot(page);
          expect(lostLines(first, again), `${where}: data gone after refresh`).toEqual([]);
          expect(again.rows, `${where}: table rows lost after refresh`).toBeGreaterThanOrEqual(first.rows);
        });

        if (label !== home) {
          await step(page, `${where} > go to ${home} and back`, async () => {
            await navTo(page, home);
            await navTo(page, label);
            expect(await settle(page)).toBe(true);
            const back = await snapshot(page);
            expect(lostLines(first, back), `${where}: data gone after navigating away and back`).toEqual([]);
            expect(back.rows, `${where}: table rows lost after navigating back`).toBeGreaterThanOrEqual(first.rows);
          });
        }

        await step(page, `${where} > every tab, filter, search and dialog`, async () => {
          await exerciseControls(page, monitor, where);
          await expectHealthy(page, `${where} (after controls)`);
        });
      });
    }
  });
}
