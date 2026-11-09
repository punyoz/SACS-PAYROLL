// The attendance SCREEN only (the rules are in api.spec.mjs). Saved sessions,
// no fixed waits, animations off, analytics / photos blocked.
//   render   each role at 1366 and 390; on its page also 768, 1920 and dark
//   clicks   one per interaction: a tile filters, the range popover, the phone
//            Filters sheet, the phone cards, the sticky header
import { test, expect } from "@playwright/test";
import { ATT_PAGE, SEED, stateFile } from "./roles.mjs";

test.describe.configure({ mode: "parallel" });

// The view keeps the range in the address: open every page on the seeded range.
const KEY = { employee: "emp_att", admin: "adm_att", hr: "hr_att", accountant: "ac_att", super_admin: "sa_att" };
const urlFor = (role, extra = {}) => `${ATT_PAGE[role]}&${new URLSearchParams({ [`${KEY[role]}_from`]: SEED.from, [`${KEY[role]}_to`]: SEED.to, ...extra })}`;
const API = { admin: "/api/admin/branch-oversight" };

/** Animations off, nothing the checks do not need (analytics, monitoring, photos). */
async function quiet(page) {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
  });
  await page.route(/\/(monitoring|_vercel)\b|\/storage\/v1\/object\//, (route) => route.abort());
}

/** Open the role's attendance view and wait for its own data request. */
async function open(page, role, extra) {
  const data = page.waitForResponse((res) => res.url().includes(API[role] || "/api/attendance/logs") && res.request().method() === "GET" && res.status() < 500);
  // HR also loads its review queues; wait for those too so nothing moves afterwards.
  const queues = role === "hr" ? Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/attendance/corrections")),
    page.waitForResponse((res) => res.url().includes("/api/attendance/overtime")),
  ]) : Promise.resolve();
  await page.goto(urlFor(role, extra));
  await Promise.all([data, queues]);
  await page.getByTestId("attendance-summary").waitFor();
  await expect(page.locator('[data-slot="table"] tbody tr, [data-slot="data-table-card"]').first()).toBeVisible();
}

/** The layout checks every render must pass. */
async function checkLayout(page, where, { wide }) {
  const main = page.locator("#portal-main");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${where}: no sideways page scroll`).toBeLessThanOrEqual(0);
  expect(await main.innerText(), `${where}: no "null" / "[object Object]"`).not.toMatch(/\bnull\b|\[object Object\]|\bundefined\b/);
  const report = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
    const bar = document.querySelector('[data-slot="attendance-toolbar"]');
    const controls = bar ? [...bar.querySelectorAll("input, [data-slot=select-trigger], button[data-slot=button]")].map(visible).filter(Boolean) : [];
    let overlaps = 0;
    for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
      const [a, b] = [controls[i], controls[j]];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps += 1;
    }
    const centres = controls.map((r) => r.top + r.height / 2);
    const cut = [...document.querySelectorAll('[data-testid="attendance-tile"] span, [role=tab], [data-testid="attendance-actions"] button')]
      .filter((el) => visible(el) && el.scrollWidth > el.clientWidth + 1 && !el.classList.contains("truncate")).map((el) => el.textContent.trim());
    const tiles = [...document.querySelectorAll('[data-testid="attendance-tile"]')].map(visible).filter(Boolean);
    const rowsOf = new Map();
    tiles.forEach((r) => rowsOf.set(Math.round(r.top), [...(rowsOf.get(Math.round(r.top)) || []), Math.round(r.height)]));
    const uneven = [...rowsOf.values()].filter((hs) => new Set(hs).size > 1).length;
    const tabs = [...document.querySelectorAll("[role=tab]")].map(visible).filter(Boolean).map((r) => Math.round(r.top));
    return { overlaps, spread: centres.length ? Math.max(...centres) - Math.min(...centres) : 0, cut, uneven, tabRows: new Set(tabs).size };
  });
  expect(report.overlaps, `${where}: no toolbar controls overlap`).toBe(0);
  expect(report.cut, `${where}: no cut-off labels`).toEqual([]);
  expect(report.uneven, `${where}: tiles line up`).toBe(0);
  expect(report.tabRows, `${where}: tabs on one line`).toBeLessThanOrEqual(1);
  if (wide) expect(report.spread, `${where}: the toolbar is one row`).toBeLessThanOrEqual(8);
}

// What differs per role (the shared view decides the rest).
const CONTROLS = {
  employee: { search: false, branch: false, tabs: [] },
  admin: { search: true, branch: false, tabs: ["All records", "Flags sent to HR"] },
  hr: { search: true, branch: true, tabs: ["All records", "Incomplete queue", "Correction requests", "Overtime", "Blocked taps"] },
  accountant: { search: true, branch: false, tabs: ["All records", "Incomplete queue"] },
  super_admin: { search: true, branch: true, tabs: ["All records", "Blocked taps"] },
};

for (const role of Object.keys(CONTROLS)) {
  test.describe(`render: ${role}`, () => {
    test.use({ storageState: stateFile(role) });
    test.beforeEach(async ({ page }) => { await quiet(page); });

    test(`${role}: 1366 and 390; on its page also 768, 1920 and dark`, async ({ page }) => {
      const views = [[1366, "light"], [390, "light"], [768, "light"], [1920, "light"], [1366, "dark"]];
      for (const [width, theme] of views) {
        await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript((t) => { try { localStorage.setItem("sacs-ui-theme", t); } catch { /* blocked */ } }, theme);
        await open(page, role);
        await checkLayout(page, `${role} ${width}px ${theme}`, { wide: width >= 1366 });
      }
      // The controls this role gets (desktop).
      await page.setViewportSize({ width: 1366, height: 900 });
      await open(page, role);
      const c = CONTROLS[role];
      await expect(page.getByTestId("att-search")).toHaveCount(c.search ? 1 : 0);
      await expect(page.getByTestId("att-branch")).toHaveCount(c.branch ? 1 : 0);
      // Review tabs appear once the board knows the role may review: wait for them.
      await expect(page.locator("#portal-main [role=tab]")).toHaveCount(c.tabs.length);
      const tabs = await page.locator("#portal-main [role=tab]").allInnerTexts();
      expect(tabs.map((t) => t.replace(/\s*\d+$/, "").trim())).toEqual(c.tabs);
    });
  });
}

test.describe("clicks (HR, desktop)", () => {
  test.use({ storageState: stateFile("hr") });
  test.beforeEach(async ({ page }) => { await quiet(page); });

  test("a summary tile filters the table; the count matches the tile", async ({ page }) => {
    await open(page, "hr");
    const tile = page.getByTestId("attendance-tile").filter({ hasText: "Incomplete" });
    const n = Number((await tile.locator("span").first().innerText()).replace(/,/g, ""));
    const filtered = page.waitForResponse((res) => res.url().includes("status=Incomplete"));
    await tile.click();
    await filtered;
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("att-count")).toHaveText(`${n} record${n === 1 ? "" : "s"}`);
    const statuses = await page.locator('[data-slot="table"] tbody tr td:nth-child(7)').allInnerTexts();
    expect(statuses.every((t) => /Incomplete/.test(t))).toBe(true);
  });

  test("the date range popover applies From and To together", async ({ page }) => {
    await open(page, "hr");
    await page.locator("#hr_att-range-range").click();
    const pop = page.locator("[data-slot=popover-content]").filter({ has: page.locator("#hr_att-range-from") });
    await expect(pop).toBeVisible();
    await expect(pop.getByTestId("hr_att-range-apply")).toBeEnabled();
    const applied = page.waitForResponse((res) => res.url().includes("/api/attendance/logs") && res.url().includes("from=2026-10-22"));
    await pop.getByTestId("hr_att-range-apply").click();
    await applied;
    await expect(pop).toBeHidden();
    await expect(page.locator("#hr_att-range-range")).toContainText("Oct 22 – 31, 2026");
  });

  test("the table header stays in view while the rows scroll", async ({ page }) => {
    await open(page, "hr");
    const box = page.locator('[data-testid="attendance-board"] [data-slot="table-container"]');
    const head = page.locator('[data-testid="attendance-board"] thead');
    const offset = async () => (await head.boundingBox()).y - (await box.boundingBox()).y;
    const before = await offset();
    const scrolled = await box.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
    expect(scrolled, "the rows really scrolled").toBeGreaterThan(0);
    expect(Math.abs((await offset()) - before), "the header stayed at the top of the box").toBeLessThanOrEqual(1);
  });
});

test.describe("phone (Super Admin, 390px)", () => {
  test.use({ storageState: stateFile("super_admin"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(async ({ page }) => { await quiet(page); });

  test("cards: the name and the status badge on top", async ({ page }) => {
    await open(page, "super_admin");
    const card = page.locator('[data-slot="data-table-card"]').first();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-slot="badge"]').first()).toBeVisible();
  });

  test("the Filters sheet: Branch, Status, Day, Apply and Reset", async ({ page }) => {
    await open(page, "super_admin");
    await page.getByTestId("att-filters").click();
    const sheet = page.getByTestId("att-filter-sheet");
    for (const label of ["Branch", "Status", "Day"]) await expect(sheet.getByText(label, { exact: true })).toBeVisible();
    await sheet.locator("#att-status-m").click();
    await page.getByRole("option", { name: "Absent", exact: true }).click();
    const filtered = page.waitForResponse((res) => res.url().includes("status=Absent"));
    await sheet.getByRole("button", { name: "Apply" }).click();
    await filtered;
    expect(page.url()).toContain("sa_att_status=Absent");
    await page.getByTestId("att-filters").click();
    await page.getByTestId("att-filter-sheet").getByRole("button", { name: "Reset" }).click();
    await expect.poll(() => page.url()).not.toContain("sa_att_status");
  });
});
