// Report screenshots only (run with --project=report): each role's key page,
// desktop 1366 and phone 390, light and dark. The "before" set is reused from
// screenshots/2026-11-09-attendance/before (taken on the old build).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { ATT_PAGE, SEED, stateFile } from "./roles.mjs";

const SHOTS = join(process.cwd(), "screenshots", "2026-11-09-attendance", "after");
mkdirSync(SHOTS, { recursive: true });
const KEY = { employee: "emp_att", admin: "adm_att", hr: "hr_att", accountant: "ac_att", super_admin: "sa_att" };
const ID = { employee: "emp-attendance", admin: "adm-attendance", hr: "hr-attendance", accountant: "ac-attendance", super_admin: "sa-attendance" };

test.describe.configure({ mode: "parallel" });

for (const role of Object.keys(ATT_PAGE)) {
  test.describe(role, () => {
    test.use({ storageState: stateFile(role) });
    test(`screenshots: ${role}`, async ({ page }) => {
      for (const width of [1366, 390]) {
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
          await page.addInitScript((t) => { try { localStorage.setItem("sacs-ui-theme", t); } catch { /* blocked */ } }, theme);
          await page.goto(`${ATT_PAGE[role]}&${KEY[role]}_from=${SEED.from}&${KEY[role]}_to=${SEED.to}`);
          await page.getByTestId("attendance-summary").waitFor();
          await expect(page.locator('[data-slot="table"] tbody tr, [data-slot="data-table-card"]').first()).toBeVisible();
          await page.screenshot({ path: join(SHOTS, `${ID[role]}-${width}-${theme}.png`), fullPage: true });
        }
      }
    });
  });
}
