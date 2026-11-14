// Side-by-side form fields line up (2026-11-14): in every row of fields, every
// box (input, select, textarea, read-only value box) starts on the same line,
// whatever its label holds (an â“˜, a lock, a tag, a rate). Every sidebar page,
// tab and add / edit dialog of every role, desktop width. Local stack only.
// Writes test-results/field-alignment.json and one picture per finding.
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test e2e/specs/99-field-alignment.spec.mjs --project=desktop
//   ALIGN_REPORT_ONLY=1 ...   list the findings without failing
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as, ROLE_LABEL } from "../support/auth.mjs";
import { PAGES, main, navTo, settle } from "../support/portal.mjs";
import { measureAlignment } from "../support/alignment.mjs";

const OUT = join(process.cwd(), "test-results", "field-alignment");
mkdirSync(OUT, { recursive: true });
const TOLERANCE = 1; // px
const findings = [];

const OPENER = /^(\+\s*)?(Add|New|Create|Register|File|Request|Edit|Change|Set|Grant|Flag|Correct|Record|Assign)\b/i;
const NEVER = /Delete|Remove|Archive|Deactivate|Reject|Approve|Submit|Process|Generate|Release|Restore|Backup|Reset|Disable|Sign out|Log ?out|Lock|Purge|Revoke|Pay\b|Save|Unlock|Confirm|Send|Endorse|Recommend|Clear|Import|Upload|Print|Retry|Refresh|Run|Separate|Decide|Resolve/i;

async function check(page, where) {
  await page.evaluate(() => document.querySelectorAll("[data-align-finding]").forEach((e) => e.removeAttribute("data-align-finding")));
  const dialogOpen = await page.locator('[role="dialog"]:visible').count();
  const list = await page.evaluate(measureAlignment, { rootSelector: dialogOpen ? '[role="dialog"]' : "#portal-main", tolerance: TOLERANCE });
  for (const f of list) {
    const key = `${where} :: ${f.fields.join(" | ")}`;
    if (findings.some((x) => x.key === key)) continue;
    const file = `${findings.length + 1}.png`;
    await page.locator(`[data-align-finding="${f.index}"]`).first().screenshot({ path: join(OUT, file) }).catch(() => {});
    findings.push({ key, where, spread: f.spread, fields: f.fields, picture: file });
    console.log(`  âœ– ALIGN ${where}: ${f.fields.join(" | ")} (${f.spread}px)`);
  }
}

async function closeDialogs(page) {
  for (let i = 0; i < 4 && await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count(); i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

async function dialogs(page, where) {
  const seen = new Set();
  const buttons = main(page).locator("button:visible");
  const count = await buttons.count();
  for (let i = 0; i < count && seen.size < 6; i += 1) {
    const b = buttons.nth(i);
    const name = ((await b.getAttribute("aria-label").catch(() => null)) || (await b.innerText().catch(() => ""))).trim().replace(/\s+/g, " ");
    if (!name || !OPENER.test(name) || NEVER.test(name) || !(await b.isEnabled().catch(() => false))) continue;
    const kind = name.split(" ").slice(0, 2).join(" ");
    if (seen.has(kind)) continue;
    seen.add(kind);
    await b.click().catch(() => {});
    await page.waitForTimeout(700);
    if (await page.locator('[role="dialog"]:visible').count()) await check(page, `${where} > "${name}"`);
    await closeDialogs(page);
  }
}

test("the alignment check itself catches a misaligned row", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await as(page, "accountant", "ac-process");
  await settle(page);
  const rootSelector = "#portal-main";
  expect(await page.evaluate(measureAlignment, { rootSelector, tolerance: TOLERANCE }), "aligned now").toEqual([]);
  await page.locator("#pc-basic").evaluate((el) => { el.style.marginTop = "6px"; });
  const caught = await page.evaluate(measureAlignment, { rootSelector, tolerance: TOLERANCE });
  expect(caught.map((f) => f.spread)).toContain(6);
});

for (const role of Object.keys(PAGES)) {
  test(`fields line up: ${ROLE_LABEL[role]}`, async ({ page, monitor }) => {
    test.setTimeout(60 * 60 * 1000);
    monitor.allow(/^4\d\d /, /status of 4\d\d/);
    // Desktop, and a small laptop / tablet where long labels wrap (ALIGN_WIDTHS="1366,900").
    const widths = String(process.env.ALIGN_WIDTHS || "1366,900").split(",").map(Number);
    await as(page, role);
    const before = findings.length;
    for (const width of widths) for (const [, label] of PAGES[role]) {
      await page.setViewportSize({ width, height: 900 });
      const where = `${ROLE_LABEL[role]} > ${label} @${width}px`;
      await navTo(page, label).catch(() => {});
      await settle(page);
      const tabs = main(page).locator('[role="tab"]:visible');
      const tabCount = Math.max(1, await tabs.count());
      for (let t = 0; t < tabCount; t += 1) {
        if (await tabs.count()) { await tabs.nth(t).click().catch(() => {}); await settle(page); }
        const tabName = (await tabs.count()) ? ` [${(await tabs.nth(t).innerText().catch(() => "")).trim()}]` : "";
        await check(page, `${where}${tabName}`);
        await dialogs(page, `${where}${tabName}`);
      }
    }
    writeFileSync(join(OUT, "..", "field-alignment.json"), JSON.stringify(findings, null, 2));
    if (process.env.ALIGN_REPORT_ONLY !== "1") {
      expect(findings.slice(before).map((f) => `${f.where}: ${f.fields.join(" | ")}`), "side-by-side fields start on the same line").toEqual([]);
    }
  });
}
