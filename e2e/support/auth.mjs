// Signing in. The first time a role is needed it signs in through the real
// login screen (password, then the planted emailed code) and the session is
// saved; later tests restore it into the same page, so the video shows one
// continuous browser. An account allows one session at a time, so a restored
// session that was replaced signs in again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { ACCOUNTS, TEST_OTP } from "../accounts.mjs";
import { plantOtp } from "./db.mjs";
import { step } from "./banner.mjs";

export const AUTH_DIR = join(process.cwd(), "test-results", ".auth");
const stateFile = (role) => join(AUTH_DIR, `${role}.json`);

export const ROLE_LABEL = {
  super_admin: "Super Admin", admin: "Admin", admin2: "Admin (North)", hr: "HR",
  accountant: "Accountant", employee: "Employee", employee2: "Employee (Bea)", employee3: "Employee (Carlo)",
};

/** Clear this page's sign-in (cookies and stored context). */
export async function signOutLocally(page) {
  await page.context().clearCookies();
  await page.goto("/api/health");
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.removeItem("sacs-auth"); } catch { /* blocked */ } });
}

/** The real sign-in screen, with the planted code. */
export async function loginThroughUi(page, role) {
  const acct = ACCOUNTS[role];
  await step(page, `${ROLE_LABEL[role]} > Login > sign in with password + emailed code`);
  await plantOtp(acct.email);
  await page.goto("/login");
  await page.locator("#login-identity").waitFor();
  // The form hydrates after first paint; retype until the values stick.
  for (let i = 0; i < 5; i += 1) {
    await page.fill("#login-identity", acct.login);
    await page.fill("#login-password", acct.password);
    if ((await page.inputValue("#login-identity")) === acct.login && (await page.inputValue("#login-password")) === acct.password) break;
    await page.waitForTimeout(300);
  }
  await page.locator("form button[type=submit]").first().click();
  await expect(page.getByText("Check your email")).toBeVisible({ timeout: 30000 });
  await page.locator("#login-code").click();
  await page.keyboard.type(TEST_OTP, { delay: 60 });
  await page.waitForURL((url) => url.pathname.startsWith(acct.portal), { timeout: 60000 });
  await waitForPortal(page);
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(stateFile(role), JSON.stringify(await page.context().storageState()));
}

/** The portal shell is up (sidebar + main), not the boot screen. */
export async function waitForPortal(page) {
  await page.locator("#portal-main").waitFor({ timeout: 60000 });
}

/**
 * Become `role` in this page: restore the saved session, or sign in. Lands on
 * the role's portal (optionally a page id, e.g. "hr-payroll-approval").
 */
export async function as(page, role, pageId) {
  const acct = ACCOUNTS[role];
  const target = pageId ? `${acct.portal}?page=${pageId}` : acct.portal;
  if (existsSync(stateFile(role))) {
    const state = JSON.parse(readFileSync(stateFile(role), "utf8"));
    await signOutLocally(page);
    await page.context().addCookies(state.cookies);
    const origin = state.origins.find((o) => page.url().startsWith(o.origin));
    if (origin) {
      await page.evaluate((entries) => { for (const { name, value } of entries) localStorage.setItem(name, value); }, origin.localStorage);
    }
    await step(page, `${ROLE_LABEL[role]} > open ${target}`);
    await page.goto(target);
    const landed = await Promise.race([
      page.locator("#portal-main").waitFor({ timeout: 30000 }).then(() => "portal"),
      page.waitForURL(/\/login/, { timeout: 30000 }).then(() => "login"),
    ]).catch(() => "unknown");
    if (landed === "portal" && new URL(page.url()).pathname.startsWith(acct.portal)) return;
  } else {
    await signOutLocally(page);
  }
  await loginThroughUi(page, role);
  if (pageId) {
    await page.goto(target);
    await waitForPortal(page);
  }
}
