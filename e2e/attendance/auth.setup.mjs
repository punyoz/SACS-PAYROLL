// Sign in ONCE per role and keep the session (Playwright storageState) in
// test-results/.auth-attendance/<role>.json (gitignored). Every attendance
// test reuses it; a role signs in again only when its saved session is close
// to expiring. The emailed code is planted in the LOCAL database (as the main
// suite does). Nothing here prints a code, a password or a session.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { ACCOUNTS, TEST_OTP } from "../accounts.mjs";
import { plantOtp } from "../support/db.mjs";
import { ATT_AUTH_DIR, ATT_ROLES, stateFile } from "./roles.mjs";

function usable(role) {
  try {
    if (!existsSync(stateFile(role))) return false;
    const state = JSON.parse(readFileSync(stateFile(role), "utf8"));
    const cookie = state.cookies.find((c) => c.name === "sacs-session");
    const payload = JSON.parse(Buffer.from(String(cookie?.value || "").split(".")[0], "base64url").toString("utf8"));
    return Number(payload.exp || 0) - Date.now() / 1000 > 15 * 60;
  } catch {
    return false;
  }
}

for (const role of ATT_ROLES) {
  test(`sign in once: ${role}`, async ({ page }) => {
    test.skip(usable(role), "saved session still valid");
    const acct = ACCOUNTS[role];
    await plantOtp(acct.email);
    await page.goto("/login");
    await page.locator("#login-identity").fill(acct.login);
    await page.locator("#login-password").fill(acct.password);
    await expect(page.locator("#login-password")).toHaveValue(acct.password);
    await page.locator("form button[type=submit]").first().click();
    await page.locator("#login-code").click();
    await page.keyboard.type(TEST_OTP);
    await page.waitForURL((url) => url.pathname.startsWith(acct.portal), { timeout: 60000 });
    await page.locator("#portal-main").waitFor({ timeout: 60000 });
    mkdirSync(ATT_AUTH_DIR, { recursive: true });
    await page.context().storageState({ path: stateFile(role) });
  });
}
