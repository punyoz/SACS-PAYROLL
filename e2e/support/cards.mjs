// Summary cards (2026-11-14): walk every card link of a page, open it in
// place, and compare its number with the rows the opened view shows.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { ACCOUNTS } from "../accounts.mjs";
import { settle } from "./portal.mjs";

const pageParam = (page) => new URL(page.url()).searchParams.get("page");

/** Every card link on the page: its label, number and address. */
export async function cardLinks(page) {
  return page.locator('#portal-main a[data-testid="stat-card-link"]').evaluateAll((links) => links.map((a) => ({
    aria: a.getAttribute("aria-label"),
    href: a.getAttribute("href"),
  })));
}

/** The rows the opened view shows: the attendance count, a table's "of N", or its body rows. */
export async function shownRows(page, scope = "#portal-main") {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) || document;
    const att = root.querySelector('[data-testid="att-count"]');
    if (att) return Number(att.textContent.replace(/[^\d]/g, ""));
    const of = [...root.querySelectorAll("*")].find((el) => el.children.length === 0 && /^Showing \d+–\d+ of \d+$/.test(el.textContent.trim()));
    if (of) return Number(of.textContent.trim().split(" of ")[1]);
    const table = root.querySelector("table tbody");
    if (!table) return null;
    return [...table.querySelectorAll("tr")].filter((tr) => tr.querySelectorAll("td").length > 1).length;
  }, scope);
}

export const report = [];
function record(row) {
  report.push(row);
  console.log(`  CARD ${row.role} ${row.page} "${row.card}" -> ${row.href} | number ${row.number} rows ${row.rows} ${row.match ? "MATCH" : "differs"}`);
}
/** Save what was walked (one file per worker). */
export function saveReport(dir, name) {
  writeFileSync(join(dir, `${name}-${process.pid}.json`), JSON.stringify(report, null, 2));
}

/**
 * Every card of `pageId`: click it (in place), check the address carries the
 * card's filters, count the rows, come back. Same-page cards must not reload.
 */
export async function walkCards(page, role, pageId, { tabEnter = false, strict = false, label = "" } = {}) {
  await page.goto(`${ACCOUNTS[role].portal}?page=${pageId}`);
  await page.locator("#portal-main").waitFor();
  await settle(page);
  const links = await cardLinks(page);
  for (const [i, link] of links.entries()) {
    const card = page.locator('#portal-main a[data-testid="stat-card-link"]').nth(i);
    const number = Number(String(link.aria.split(":")[1] || "").replace(/[^\d.]/g, "").split(".")[0]);
    const wanted = new URLSearchParams(link.href.startsWith("#") ? "" : link.href.replace(/^[^?]*\?/, ""));
    const samePage = link.href.startsWith("#") || (wanted.get("page") ? wanted.get("page") === pageId : true);
    await page.evaluate(() => { window.__noReload = true; });
    if (tabEnter && i === 0) { await card.focus(); await page.keyboard.press("Enter"); } else await card.click();
    await settle(page);
    // No full reload: the marker survives an in-place navigation.
    expect(await page.evaluate(() => window.__noReload), `${link.aria}: opened without a reload`).toBe(true);
    const now = new URL(page.url()).searchParams;
    // A filter set to the page's default is left out of the address (useUrlParam).
    for (const [k, v] of wanted) expect([v, ...(samePage && ["all", "open"].includes(v) ? [null] : [])], `${link.aria}: ?${k}`).toContain(now.get(k));
    // Same page: the table the card scrolled to; another page: its main view.
    const rows = link.href.startsWith("#") ? await page.locator(link.href).locator("li, tr").count()
      : await shownRows(page, samePage ? '#portal-main [id$="-table"]' : "#portal-main");
    // The filter shows in the page's own controls.
    const status = [...wanted].find(([k]) => /_status$|_filter$|_branch$/.test(k));
    if (status && status[1] !== "all") {
      const shown = await page.locator('#portal-main [data-testid="att-status"], #portal-main [aria-pressed="true"], #portal-main [aria-selected="true"], #portal-main [data-state="on"], #portal-main [data-state="active"], #portal-main [data-testid="loan-status-filter"], #portal-main [role="combobox"]').allInnerTexts();
      expect(shown.join(" ").length, `${link.aria}: the filter is shown`).toBeGreaterThan(0);
    }
    record({ role, page: pageId, label, card: link.aria, href: link.href, number, rows, match: rows === number });
    if (strict) expect(rows, `${label} ${link.aria}: the opened rows equal the card's number`).toBe(number);
    if (!samePage) { await page.goBack(); await settle(page); expect(pageParam(page)).toBe(pageId); }
  }
  return links.length;
}
