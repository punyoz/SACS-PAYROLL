// Exercise the controls of the page on screen without changing real data:
// every sub-tab, search box, dropdown filter, pagination, sortable column,
// dialog (opened, submitted empty, closed) and export. Actions that save,
// approve, delete or move money are left to the business-flow specs.
import { expect } from "@playwright/test";
import { step } from "./banner.mjs";
import { settle } from "./portal.mjs";

const OPENER = /^(\+\s*)?(Add|New|Create|Register|File|Request|Assign|Apply|Edit|View|Details|Review|Show)\b/i;
const NEVER = /Delete|Remove|Archive|Deactivate|Reject|Approve|Submit|Process|Generate|Release|Restore|Backup|Reset|Disable|Sign out|Log ?out|Lock|Purge|Revoke|Mark|Pay\b|Save|Unlock|Terminal|Confirm|Send|Endorse|Recommend|Clear|Import|Upload|Print|Retry|Try again|Refresh|Lost|Replace|Reactivate|Cancel|Resolve|Decide|Forward|Return/i;
const EXPORT = /Export|Download|CSV|Excel|PDF/i;
const NO_MATCH = "zzqx-no-such-thing";

const visible = async (locator) => {
  const out = [];
  for (let i = 0; i < await locator.count(); i += 1) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) out.push(el);
  }
  return out;
};

async function noErrorScreen(page, where) {
  const text = await page.locator("#portal-main").innerText().catch(() => "");
  expect(text, `${where}: error screen`).not.toMatch(/Application error|Unhandled Runtime Error/);
}

async function closeDialogs(page) {
  for (let i = 0; i < 3; i += 1) {
    const open = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [role="listbox"]:visible, [role="menu"]:visible');
    if (!(await open.count())) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await expect(page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible'), "a dialog would not close").toHaveCount(0);
}

async function searches(page, monitor, where) {
  const boxes = await visible(page.locator('#portal-main input[type="search"], #portal-main input[placeholder^="Search" i], #portal-main input[aria-label^="Search" i]'));
  for (const box of boxes.slice(0, 2)) {
    if (!(await box.isEnabled())) continue;
    const before = await page.locator("#portal-main table tbody tr").count();
    await step(page, `${where} > search for nonsense`);
    await box.fill(NO_MATCH);
    await settle(page);
    await noErrorScreen(page, where);
    await box.fill("");
    await settle(page);
    const after = await page.locator("#portal-main table tbody tr").count();
    expect(after, `${where}: rows did not come back after clearing the search`).toBeGreaterThanOrEqual(before);
  }
}

async function dropdowns(page, monitor, where) {
  const triggers = await visible(page.locator('#portal-main button[role="combobox"]'));
  for (const trigger of triggers.slice(0, 4)) {
    if (!(await trigger.isEnabled())) continue;
    const name = ((await trigger.getAttribute("aria-label")) || (await trigger.innerText())).trim().slice(0, 40);
    const original = (await trigger.innerText()).trim();
    await step(page, `${where} > dropdown "${name}"`);
    await trigger.click();
    const options = page.locator('[role="option"]:visible');
    await options.first().waitFor({ timeout: 5000 }).catch(() => {});
    const count = await options.count();
    if (count > 1) {
      const pick = options.nth(1);
      const pickText = (await pick.innerText()).trim();
      if (!/Delete|Remove/i.test(pickText)) {
        await pick.click();
        await settle(page);
        await noErrorScreen(page, `${where} [${name}=${pickText}]`);
        // Put the original choice back.
        if (await trigger.isVisible().catch(() => false)) {
          await trigger.click();
          const back = page.locator('[role="option"]:visible').filter({ hasText: original }).first();
          if (await back.count()) await back.click(); else await page.keyboard.press("Escape");
          await settle(page);
        }
      } else {
        await page.keyboard.press("Escape");
      }
    } else {
      await page.keyboard.press("Escape");
    }
    await closeDialogs(page);
  }
}

async function paging(page, where) {
  const next = await visible(page.locator('#portal-main button[aria-label="Next page"]'));
  for (const button of next.slice(0, 1)) {
    if (!(await button.isEnabled())) continue;
    await step(page, `${where} > next page`);
    await button.click();
    await settle(page);
    await noErrorScreen(page, where);
    const prev = page.locator('#portal-main button[aria-label="Previous page"]').first();
    if (await prev.isEnabled().catch(() => false)) { await prev.click(); await settle(page); }
  }
  const sortable = (await visible(page.locator('#portal-main thead button:not([role="checkbox"]):not([disabled])'))).slice(0, 1);
  for (const header of sortable) {
    await step(page, `${where} > sort by "${(await header.innerText()).trim()}"`);
    await header.click();
    await header.click();
    await settle(page);
    await noErrorScreen(page, where);
  }
}

async function dialogs(page, monitor, where) {
  const seen = new Set();
  const buttons = await visible(page.locator('#portal-main button:not([role="combobox"]):not([role="tab"])'));
  for (const button of buttons) {
    if (seen.size >= 4) break;
    // An earlier dialog may have re-rendered the list: skip buttons that are gone.
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = await button.getAttribute("aria-label", { timeout: 2000 }).catch(() => null);
    const name = (label || (await button.innerText({ timeout: 2000 }).catch(() => ""))).trim().replace(/\s+/g, " ");
    if (!name || !OPENER.test(name) || NEVER.test(name) || EXPORT.test(name)) continue;
    const kind = name.split(" ")[0].toLowerCase() + name.split(" ").slice(1, 3).join(" ");
    if (seen.has(kind) || !(await button.isVisible().catch(() => false)) || !(await button.isEnabled().catch(() => false))) continue;
    seen.add(kind);
    await step(page, `${where} > open "${name}"`);
    const urlBefore = page.url();
    await button.click();
    await page.waitForTimeout(700);
    const dialog = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').last();
    if (await dialog.count()) {
      const submit = dialog.locator('button[type="submit"]').last();
      if (await submit.count() && await submit.isEnabled().catch(() => false) && !NEVER.test(await submit.innerText())) {
        await step(page, `${where} > "${name}" > submit empty`);
        await submit.click();
        await page.waitForTimeout(900);
        if (!(await dialog.isVisible().catch(() => false))) {
          monitor.warnings.push({ where, text: `"${name}": the empty form was accepted (dialog closed)` });
        }
      }
      await closeDialogs(page);
    } else if (page.url().split("?")[0] !== urlBefore.split("?")[0]) {
      await page.goBack();
    } else {
      await closeDialogs(page);
    }
    await settle(page);
    await noErrorScreen(page, where);
  }
}

async function exportsOf(page, monitor, where) {
  const buttons = await visible(page.locator("#portal-main button, #portal-main a[download]"));
  let tried = 0;
  for (const button of buttons) {
    if (tried >= 2) break;
    const name = (await button.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
    if (!EXPORT.test(name) || /Print/i.test(name) || !(await button.isEnabled().catch(() => false))) continue;
    tried += 1;
    await step(page, `${where} > export "${name}"`);
    const download = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
    const popup = page.context().waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await button.click();
    const menu = page.locator('[role="menuitem"]:visible').first();
    if (await menu.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) await menu.click();
    const [file, tab] = await Promise.all([download, popup]);
    if (tab) await tab.close();
    if (!file && !tab) {
      const notice = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
      monitor.warnings.push({ where, text: `export "${name}" produced no file${notice.length ? ` (toast: ${notice.join(" | ")})` : ""}` });
    }
    await closeDialogs(page);
  }
}

async function inPlace(page, monitor, where) {
  await searches(page, monitor, where);
  await dropdowns(page, monitor, where);
  await paging(page, where);
  await exportsOf(page, monitor, where);
  await dialogs(page, monitor, where);
}

export async function exerciseControls(page, monitor, where) {
  const tabs = page.locator('#portal-main [role="tab"]');
  const count = await tabs.count();
  if (!count) {
    await inPlace(page, monitor, where);
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const tab = tabs.nth(i);
    if (!(await tab.isVisible().catch(() => false))) continue;
    const name = (await tab.innerText()).trim().replace(/\s+/g, " ");
    await step(page, `${where} > tab "${name}"`);
    await tab.click();
    expect(await settle(page), `${where} > ${name}: still loading`).toBe(true);
    await noErrorScreen(page, `${where} > ${name}`);
    await inPlace(page, monitor, `${where} > ${name}`);
  }
  // A control may have opened a sub-view without the tabs; go back to them.
  if (await tabs.first().isVisible().catch(() => false)) {
    await tabs.first().click();
    await settle(page);
  }
}
