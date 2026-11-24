// Every date picker (2026-11-19, the night before the defense): picking a
// date crashed HR > User Management ("This screen could not be loaded").
// Cause: the Employees table reported its rows back to the page through
// onRowsShown, and the page handed it a new array on every render, so any
// re-render (picking a date) looped until React gave up.
//
// Part 1 visits every page and sub-tab of every role, opens its dialogs, and
// in each date picker picks a day: the screen must not crash and the field
// must show exactly the day picked (no off-by-one from the time zone). Nothing
// is saved. The ids it reached go to test-results/date-pickers.json.
// Part 2 saves dates in the employee form (where it crashed) and reopens it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { PAGES, main, settle } from "../support/portal.mjs";
import { pickDate, lastToast } from "../support/flow.mjs";

const OPENER = /^(\+\s*)?(Add|New|Create|Register|File|Request|Assign|Apply|Edit|View|Details|Review|Separate|Record|Change|Set|Suspend|Grant|Give|Bulk|Schedule|Post|Correct)\b/i;
const NEVER = /Delete|Remove|Archive|Deactivate|Reject|Approve|Submit|Process|Generate|Release|Restore|Backup|Reset|Disable|Sign out|Log ?out|Lock|Purge|Revoke|Mark|Pay\b|Save|Unlock|Terminal|Confirm|Send|Endorse|Recommend|Clear|Import|Upload|Print|Retry|Try again|Refresh|Lost|Replace|Reactivate|Cancel|Resolve|Decide|Forward|Return|Export|Download|CSV|Excel|PDF/i;
const TRIGGER = 'button:has(svg.lucide-calendar):not([disabled])';
const reached = {};
// By design these move a past day forward (suspension: to today; incentives: to Oct 1, 2026).
const CLAMPED = ["hr-susp-date", "ac-item-date"];

async function crashed(page) {
  return /This screen could not be loaded|Application error|Unhandled Runtime Error/.test(await page.locator("body").innerText().catch(() => ""));
}

/** Click a date picker, pick a day the calendar allows, check the field shows that day. */
async function pickAny(page, trigger, where) {
  // Hold the exact element: a pick may re-render the list and shift nth() onto another field.
  const handle = await trigger.elementHandle({ timeout: 5000 }).catch(() => null);
  if (!handle) return;
  const id = await handle.getAttribute("id").catch(() => null);
  const before = (await handle.innerText().catch(() => "")).trim();
  if (!(await handle.click({ timeout: 5000 }).then(() => true, () => false))) return;
  const pop = page.locator("[data-radix-popper-content-wrapper]:visible").last();
  if (!(await pop.locator('[data-slot="calendar"]').waitFor({ timeout: 4000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape");
    return;
  }
  const calendar = await pop.locator('[data-slot="calendar"]').elementHandle();
  // Not the selected day: clicking it again clears the field (react-day-picker single mode).
  const days = pop.locator('td[data-day]:not([data-outside]):not([data-disabled]):not([data-hidden]):not([data-selected]) button');
  if (!(await days.count())) { await page.keyboard.press("Escape"); return; }
  // The 15th when allowed, else the last day allowed in the month shown.
  const mid = pop.locator('td[data-day$="-15"]:not([data-outside]):not([data-disabled]):not([data-selected]) button');
  const cell = (await mid.count()) ? mid.first() : days.last();
  const iso = await cell.locator("xpath=..").getAttribute("data-day");
  await cell.click();
  // This calendar (not an outer range popover) closes.
  await expect.poll(() => calendar.isVisible().catch(() => false), { message: `${where}: calendar did not close after picking ${iso}` }).toBe(false);
  expect(await crashed(page), `${where}: screen crashed after picking ${iso} in ${id || before}`).toBe(false);
  const expected = await page.evaluate((k) => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
  }, iso);
  // Same element still on screen: it shows the day picked (a filter may legitimately replace it).
  if (!CLAMPED.includes(id) && await handle.isVisible().catch(() => false)) {
    expect((await handle.innerText()).trim(), `${where}: picked ${iso} but ${id || "the field"} shows something else`).toContain(expected);
    // The other earlier bug (2026-11-21, finding c): clicking the day already chosen cleared the field. It stays chosen.
    if (await handle.click({ timeout: 5000 }).then(() => true, () => false)) {
      const again = page.locator("[data-radix-popper-content-wrapper]:visible").last();
      const chosen = again.locator("td[data-selected] button").first();
      if (await chosen.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
        await chosen.click();
        expect(await crashed(page), `${where}: screen crashed after re-clicking ${iso}`).toBe(false);
        if (await again.isVisible().catch(() => false)) await page.keyboard.press("Escape");
        if (await handle.isVisible().catch(() => false)) {
          expect((await handle.innerText()).trim(), `${where}: re-clicking ${iso} cleared ${id || "the field"}`).toContain(expected);
        }
      } else {
        await page.keyboard.press("Escape");
      }
    }
  }
  (reached[where] ||= []).push(id || before || "(no id)");
}

/** Every date picker and native date input visible inside `scope`. */
async function pickAllIn(page, scope, where) {
  // A licensed-teacher switch hides its expiry date until turned on (no save).
  const sw = scope.locator('#emp-license-switch[aria-checked="false"]:not([disabled])');
  if (await sw.isVisible().catch(() => false)) await sw.click();
  const change = scope.getByRole("button", { name: "Change number, expiry or ID" });
  if (await change.isVisible().catch(() => false)) await change.click();
  const triggers = scope.locator(TRIGGER);
  for (let i = 0; i < await triggers.count(); i += 1) {
    const t = triggers.nth(i);
    if (await t.isVisible().catch(() => false)) await pickAny(page, t, where);
    if (await crashed(page)) break;
  }
  // Date range filters: the From / To pickers live in a popover.
  const ranges = scope.locator('button[id$="-range"]');
  for (let i = 0; i < await ranges.count(); i += 1) {
    const r = ranges.nth(i);
    if (!(await r.isVisible().catch(() => false))) continue;
    await r.click();
    const pop = page.locator("[data-radix-popper-content-wrapper]:visible").last();
    await pop.waitFor({ timeout: 4000 }).catch(() => {});
    for (const end of ["from", "to"]) {
      const inner = pop.locator(`button[id$="-${end}"]`);
      if (await inner.isVisible().catch(() => false)) await pickAny(page, inner, `${where} (range ${end})`);
    }
    await page.keyboard.press("Escape");
  }
  const natives = scope.locator('input[type="date"]:not([disabled]):not([readonly])');
  for (let i = 0; i < await natives.count(); i += 1) {
    const n = natives.nth(i);
    if (!(await n.isVisible().catch(() => false))) continue;
    const min = (await n.getAttribute("min")) || "";
    const value = min > "2026-11-15" ? min : "2026-11-15";
    await n.fill(value);
    await expect(n).toHaveValue(value);
    (reached[where] ||= []).push(`${(await n.getAttribute("id")) || "native"} (native)`);
  }
}

async function closeAll(page) {
  for (let i = 0; i < 4; i += 1) {
    if (!(await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [data-radix-popper-content-wrapper]:visible').count())) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

async function sweepView(page, where) {
  await pickAllIn(page, main(page), where);
  await closeAll(page);
  const seen = new Set();
  const buttons = main(page).locator('button:not([role="combobox"]):not([role="tab"])');
  const count = await buttons.count();
  for (let i = 0; i < count && seen.size < 8; i += 1) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) continue;
    const name = ((await b.getAttribute("aria-label")) || (await b.innerText({ timeout: 2000 }).catch(() => ""))).trim().replace(/\s+/g, " ");
    if (!name || !OPENER.test(name) || NEVER.test(name)) continue;
    const kind = name.split(" ").slice(0, 2).join(" ").toLowerCase();
    if (seen.has(kind)) continue;
    seen.add(kind);
    const url = page.url();
    await b.click();
    await page.waitForTimeout(600);
    const dialog = page.locator('[role="dialog"]:visible').last();
    if (await dialog.count()) await pickAllIn(page, dialog, `${where} > "${name}"`);
    else await pickAllIn(page, main(page), `${where} > "${name}"`);
    expect(await crashed(page), `${where} > "${name}": screen crashed`).toBe(false);
    await closeAll(page);
    if (page.url().split("?")[0] !== url.split("?")[0]) await page.goBack();
    await settle(page);
  }
}

for (const role of Object.keys(PAGES)) {
  test(`date pickers: every ${ROLE_LABEL[role]} page`, async ({ page, monitor }) => {
    test.setTimeout(20 * 60 * 1000);
    for (const [id, label] of PAGES[role]) {
      const where = `${ROLE_LABEL[role]} > ${label}`;
      monitor.at(where);
      await step(page, `${where} > every date picker`, async () => {
        await as(page, role, id);
        await settle(page);
        const tabs = main(page).locator('[role="tab"]');
        const n = await tabs.count();
        if (!n) { await sweepView(page, where); return; }
        for (let i = 0; i < n; i += 1) {
          const tab = tabs.nth(i);
          if (!(await tab.isVisible().catch(() => false))) continue;
          const name = (await tab.innerText()).trim().replace(/\s+/g, " ");
          await tab.click();
          await settle(page);
          await sweepView(page, `${where} > ${name}`);
        }
      });
    }
  });
}

// The crash report: Edit employee > Licensed teacher > License expiry date.
// The license has its own save, so this saves for real and reopens. (The
// seeded test employees lack required 201 fields, so the main form is only
// picked in, not saved, by the sweep above.)
test("date pickers: license expiry date saves and shows the same day after reopening", async ({ page, monitor }) => {
  monitor.at("HR > User Management > Edit Ana > license expiry");
  const dialogOf = async () => {
    await as(page, "hr", "hr-employees");
    await main(page).locator("tr", { hasText: "Ana" }).first().getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#emp-license-switch").waitFor();
    return dialog;
  };
  let day = "2030-01-31";
  let label = "Jan 31, 2030";
  await step(page, "HR > Edit Ana > pick date of birth, date hired, then license expiry and save the license", async () => {
    const dialog = await dialogOf();
    await pickDate(page, dialog.locator("#emp-form-date_of_birth"), "1991-03-01");
    await pickDate(page, dialog.locator("#emp-form-date_hired"), "2024-01-31");
    expect(await crashed(page)).toBe(false);
    if (await dialog.locator('#emp-license-switch[aria-checked="false"]').count()) {
      await dialog.locator("#emp-license-switch").click();
      await dialog.locator("#emp-license-no").fill("0123456");
    } else {
      await dialog.getByRole("button", { name: "Change number, expiry or ID" }).click();
    }
    // A different day from the one saved (clicking the selected day clears it).
    if ((await dialog.locator("#emp-license-exp").innerText()).includes(label)) { day = "2030-02-28"; label = "Feb 28, 2030"; }
    await pickDate(page, dialog.locator("#emp-license-exp"), day);
    expect(await crashed(page), "crashed after picking the license expiry").toBe(false);
    await expect(dialog.locator("#emp-license-exp")).toContainText(label);
    await dialog.locator("#emp-license-reason").fill("E2E: date picker check");
    await dialog.getByRole("button", { name: /Save license/ }).click();
    await expect(dialog.getByText(label), `not saved: ${await lastToast(page)}`).toBeVisible({ timeout: 30000 });
    await page.keyboard.press("Escape");
  });
  await step(page, "HR > Edit Ana > reopen: the same expiry day (no day shift)", async () => {
    const dialog = await dialogOf();
    await expect(dialog.getByText(label)).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

// Merged into the file: a failed test restarts the worker and loses `reached`.
test.afterEach(() => {
  const dir = join(process.cwd(), "test-results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "date-pickers.json");
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...saved, ...reached }, null, 2));
});
