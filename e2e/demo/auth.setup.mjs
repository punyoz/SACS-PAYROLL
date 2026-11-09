// Sign in once per audit role through the real login form (password + the
// emailed code). LOCAL: the code is planted in the local database, as the E2E
// harness does. PRODUCTION (DEMO_AUDIT_BASE set): the person running the audit
// types each code from the inbox (headed; never planted, never printed).
import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { plantOtp } from "../support/db.mjs";
import { TEST_OTP } from "../accounts.mjs";
import { AUDIT_ROLES, AUTH_DIR, credentials, stateFile } from "./roles.mjs";

const local = !process.env.DEMO_AUDIT_BASE || /localhost|127\.0\.0\.1/.test(process.env.DEMO_AUDIT_BASE);

for (const [role, { tag, portal }] of Object.entries(AUDIT_ROLES)) {
  test(`sign in: ${role}`, async ({ page }) => {
    test.setTimeout(local ? 120000 : 600000);
    const { email, password } = credentials()[tag];
    if (local) await plantOtp(email);
    await page.goto("/login");
    await page.locator("#login-identity").waitFor();
    for (let i = 0; i < 5; i += 1) {
      await page.fill("#login-identity", email);
      await page.fill("#login-password", password);
      if ((await page.inputValue("#login-identity")) === email) break;
    }
    await page.locator("form button[type=submit]").first().click();
    await expect(page.getByText("Check your email")).toBeVisible({ timeout: 30000 });
    if (local) {
      await page.locator("#login-code").click();
      await page.keyboard.type(TEST_OTP);
    }
    // Production: the tester types the code from the inbox into the open window.
    await page.waitForURL((url) => url.pathname.startsWith(portal), { timeout: local ? 60000 : 540000 });
    await page.locator("#portal-main").waitFor({ timeout: 60000 });
    mkdirSync(AUTH_DIR, { recursive: true });
    writeFileSync(stateFile(role), JSON.stringify(await page.context().storageState()));
  });
}
