// G8 empty-page audit: every page and tab of every role, at 1366 px and 390 px.
// Records rows / cards per page and fails on an empty state, or on "null",
// "undefined", "NaN" or "[object Object]" shown to the user. READ-ONLY: it
// only opens pages and tabs (no button that changes data is pressed).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { AUDIT_ROLES, OUT_DIR, stateFile } from "./roles.mjs";

test.describe.configure({ mode: "parallel" });

const BAD_TEXT = /\bnull\b|\bundefined\b|\bNaN\b|\[object Object\]/;

/**
 * Empty states that are RIGHT for the demo (reported as "expected", with the
 * reason, never hidden). Anything else empty fails the audit.
 */
const EXPECTED_EMPTY = [
  [/^No payslip selected$|^No report (generated )?yet$|^No records for selected period$/, "needs a click (choose a payslip / generate a report)"],
  [/^Nobody is waiting: every employee left out has been paid$/, "a good result: nobody left out of a run"],
  [/^No annualization for 2026 yet$|^No 13th month yet$/, "December only (the 13th month and the year-end tax are processed from Dec 1)"],
  [/^No paid payslips in 2025$/, "the system starts in 2026: no 2025 payroll exists"],
  [/subsidy|^Nothing (here yet|pending|processed|approved|rejected|applied to payroll)$|^No decisions yet$/i, "subsidy: an approved item is Applied when the next payroll runs; Pending and excess settlements are raised by the system only when an advance exceeds the entitlement"],
  [/^Nothing waits on the fallback$/, "correct: both HR are active, so nothing waits on the Super Admin"],
  [/^No suspensions declared from today on$/, "a suspension is a school-wide rule that would also affect real accounts: not seeded"],
  [/^No payslips this month$/, "this month's cutoff is left open to process live in the defense"],
  [/^No accounts found$/, "local only: production already has an archived account"],
  [/^No employees found\.$/, "local-only branches (e.g. Main Campus) and the Unassigned tab"],
  [/^Nobody tapped in without an assignment$/, "the page opens on the next holiday (Nov 30): nobody can have tapped in yet", { page: /Holidays/ }],
  [/^No recent payroll activity$/, "this month's cutoff is left open to process live in the defense", { page: /Dashboard/ }],
  [/^No payroll records found$/, "held pay shows once the held person's cutoff is processed (live)", { tab: /On hold/ }],
  [/^No payroll records found$/, "a branch's latest run is either waiting or rejected; the other branches show the other state", { tab: /Pending HR Approval|Rejected by HR/ }],
  [/^No (loans|cash advances|incentives) yet$/, "the only Accountant of a branch cannot file their own requests, and no other Accountant exists there (the payslip is the only self-processed item)", { role: /accountant_single/, page: /My Requests/ }],
  [/^No records found\.$/, "a report not generated yet", { page: /HR Reports/ }],
];
const expectedReason = (text, where = {}) => EXPECTED_EMPTY.find(([re, , when = {}]) => re.test(text)
  && (!when.page || when.page.test(where.page || "")) && (!when.tab || when.tab.test(where.tab || "")) && (!when.role || when.role.test(where.role || "")))?.[1] || null;

/**
 * Track the page's own data calls (fetch / XHR to /api, not the live
 * streams), so "settled" means every call it made has answered.
 */
function trackRequests(page) {
  const inflight = new Set();
  const isData = (req) => ["fetch", "xhr"].includes(req.resourceType()) && /\/api\//.test(req.url()) && !/\/stream|\/notifications/.test(req.url());
  page.on("request", (req) => { if (isData(req)) inflight.add(req); });
  for (const done of ["requestfinished", "requestfailed"]) page.on(done, (req) => inflight.delete(req));
  page.__inflight = inflight;
}

/** Wait until the page's data calls have answered and stayed quiet briefly (event-driven, capped). */
async function settle(page) {
  const started = Date.now();
  let quietSince = 0;
  while (Date.now() - started < 8000) {
    if (page.__inflight.size === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 350) break;
    } else quietSince = 0;
    await page.waitForEvent("requestfinished", { timeout: 150 }).catch(() => null);
  }
  await page.locator("#portal-main [data-slot=skeleton]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
}

async function measure(page) {
  return page.evaluate((bad) => {
    const main = document.querySelector("#portal-main");
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rows = [...main.querySelectorAll("[data-slot=table] tbody tr")].filter((tr) => visible(tr) && !tr.querySelector("[data-slot=empty-state]")).length;
    const cards = [...main.querySelectorAll("[data-slot=data-table-card]")].filter(visible).length;
    const empties = [...main.querySelectorAll("[data-slot=empty-state]")].filter(visible).map((el) => el.querySelector("p")?.textContent?.trim() || "empty");
    const text = main.innerText || "";
    const badMatch = text.match(new RegExp(bad));
    return { rows, cards, empties, bad: badMatch ? text.slice(Math.max(0, badMatch.index - 40), badMatch.index + 30).replace(/\s+/g, " ") : null };
  }, BAD_TEXT.source);
}

/** Open every collapsible group, then return the sidebar's page buttons' labels. */
async function sidebarLabels(page) {
  const closed = page.locator("[data-nav-group] button[aria-expanded=false]");
  for (let i = 0; i < 12 && (await closed.count()); i += 1) await closed.first().click();
  return page.locator("[data-nav-group] [data-sidebar=menu-button]").allInnerTexts();
}

for (const [role, { portal }] of Object.entries(AUDIT_ROLES)) {
  test(`audit: ${role}`, async ({ browser }) => {
    test.setTimeout(15 * 60 * 1000);
    const results = [];
    const context = await browser.newContext({ storageState: stateFile(role), viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    trackRequests(page);
    await page.route(/\/(monitoring|_vercel)\b/, (route) => route.abort());
    await page.goto(portal);
    await page.locator("#portal-main").waitFor();
    const labels = (await sidebarLabels(page)).map((t) => t.trim()).filter(Boolean);
    const pages = [];
    for (const label of labels) {
      await sidebarLabels(page);
      const button = page.locator("[data-nav-group] [data-sidebar=menu-button]").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();
      if (!(await button.count())) continue;
      await button.click();
      await settle(page);
      // A link that leaves the portal (the RFID kiosk screen): noted, then back.
      if (!new URL(page.url()).pathname.startsWith(portal)) {
        results.push({ role, width: 1366, page: label, id: null, tab: null, rows: 0, cards: 0, empties: [], bad: null, external: new URL(page.url()).pathname });
        await page.goto(portal);
        await page.locator("#portal-main").waitFor();
        continue;
      }
      const id = new URL(page.url()).searchParams.get("page") || label;
      pages.push({ id, label });
      const base = await measure(page);
      results.push({ role, width: 1366, page: label, id, tab: null, ...base });
      const tabs = page.locator("#portal-main [role=tab]");
      const count = await tabs.count();
      for (let i = 0; i < count; i += 1) {
        const tab = tabs.nth(i);
        if (!(await tab.isVisible()) || (await tab.getAttribute("aria-selected")) === "true") continue;
        const tabLabel = (await tab.innerText()).replace(/\s*\d+$/, "").trim();
        await tab.click();
        await settle(page);
        results.push({ role, width: 1366, page: label, id, tab: tabLabel, ...(await measure(page)) });
      }
    }
    await context.close();

    // Phones: every page again at 390 px (opened by its address).
    const phone = await browser.newContext({ storageState: stateFile(role), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage();
    trackRequests(mobile);
    for (const { id, label } of pages) {
      await mobile.goto(`${portal}?page=${encodeURIComponent(id)}`);
      await mobile.locator("#portal-main").waitFor();
      await settle(mobile);
      const sideways = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      results.push({ role, width: 390, page: label, id, tab: null, ...(await measure(mobile)), sideways });
    }
    await phone.close();

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${role}.json`), JSON.stringify(results, null, 2));
    for (const r of results) {
      r.expected = r.empties.filter((e) => expectedReason(e, r)).map((e) => ({ text: e, reason: expectedReason(e, r) }));
      r.unexpected = r.empties.filter((e) => !expectedReason(e, r));
      r.result = r.unexpected.length || r.bad || (r.sideways || 0) > 0 ? "FAIL" : r.expected.length ? "OK (expected empty)" : "OK";
    }
    writeFileSync(join(OUT_DIR, `${role}.json`), JSON.stringify(results, null, 2));
    const problems = results.filter((r) => r.result === "FAIL")
      .map((r) => `${r.width}px ${r.page}${r.tab ? ` › ${r.tab}` : ""}: ${[...r.unexpected.map((e) => `empty "${e}"`), r.bad ? `shows "${r.bad}"` : null, r.sideways > 0 ? `scrolls sideways ${r.sideways}px` : null].filter(Boolean).join("; ")}`);
    expect(problems, `${role}: pages with empty states or bad text`).toEqual([]);
  });
}
