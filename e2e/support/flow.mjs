// Helpers for the business-flow specs.
import { expect } from "@playwright/test";
import { settle } from "./portal.mjs";

/** Answer the open confirmation (AlertDialog) with its action button. */
export async function confirm(page, label) {
  const dialog = page.locator('[role="alertdialog"]:visible, [role="dialog"]:visible').last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30000 });
  await settle(page);
}

/** JSON from an API route with this page's session. */
export async function api(page, method, path, body) {
  const res = await page.request.fetch(path, { method, data: body, headers: body ? { "Content-Type": "application/json" } : {} });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status(), ok: res.ok(), data };
}

/** Reload and wait for the page to settle again. */
export async function refresh(page) {
  await page.reload();
  await page.locator("#portal-main").waitFor();
  await settle(page);
}

/** The latest toast text (sonner). */
export async function lastToast(page) {
  const toasts = page.locator("[data-sonner-toast]");
  await toasts.first().waitFor({ timeout: 15000 }).catch(() => {});
  return (await toasts.allInnerTexts()).join(" | ");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Pick a "YYYY-MM-DD" day in a DatePicker (a button that opens a calendar
 * with month / year dropdowns).
 */
export async function pickDate(page, trigger, key) {
  const [y, m, d] = key.split("-").map(Number);
  await trigger.click();
  const pop = page.locator("[data-radix-popper-content-wrapper]:visible").last();
  await pop.waitFor();
  const selects = pop.locator("select");
  if (await selects.count() >= 2) {
    await selects.nth(1).selectOption(String(y)).catch(() => {});
    await selects.nth(0).selectOption({ label: MONTHS[m - 1].slice(0, 3) }).catch(async () => {
      await selects.nth(0).selectOption(String(m - 1)).catch(() => {});
    });
  }
  const label = new RegExp(`${MONTHS[m - 1]} ${d}(st|nd|rd|th)?, ${y}`);
  await pop.getByRole("button", { name: label }).first().click();
  await expect(pop).toBeHidden();
}

/** Today in Manila plus `days`, as "YYYY-MM-DD". */
export function manilaDay(days = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  now.setUTCDate(now.getUTCDate() + days);
  return now.toISOString().slice(0, 10);
}

/** Choose an option in a Radix Select by its trigger. */
export async function choose(page, trigger, option) {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
}
