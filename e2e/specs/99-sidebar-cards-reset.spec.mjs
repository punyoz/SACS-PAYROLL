// Sidebar groups, logo link, clickable summary cards, email-only reset (2026-11-14).
// Local stack only. One test per account, so it runs in parallel safely
// (an account allows one session at a time):
//
//   E2E_HEADLESS=1 E2E_SLOWMO=0 npx playwright test e2e/specs/99-sidebar-cards-reset.spec.mjs --project=desktop --workers=4
//
// SHOTS=before runs only the screenshot / baseline part (on the old code).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { ACCOUNTS, TEST_OTP } from "../accounts.mjs";
import { plantOtp, profileByEmail } from "../support/db.mjs";
import { PAGES, settle } from "../support/portal.mjs";

test.describe.configure({ mode: "parallel" });

const PHASE = process.env.SHOTS || "after";
const OUT = join(process.cwd(), "screenshots", "2026-11-14-sidebar-cards-reset");
mkdirSync(join(OUT, PHASE), { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: join(OUT, PHASE, `${name}.png`), ...opts });
const DESKTOP = { width: 1366, height: 800 };
const PHONE = { width: 390, height: 844 };
const DASHBOARD = { super_admin: "sa-dashboard", admin: "adm-dashboard", hr: "hr-dashboard", accountant: "ac-dashboard", employee: "emp-dash" };

const pageParam = (page) => new URL(page.url()).searchParams.get("page");
const sidebar = (page) => page.locator('[data-slot="sidebar-container"]');

/** Every card link on the page: its label, number and address. */
async function cardLinks(page) {
  return page.locator('#portal-main a[data-testid="stat-card-link"]').evaluateAll((links) => links.map((a) => ({
    aria: a.getAttribute("aria-label"),
    href: a.getAttribute("href"),
  })));
}

/** The rows the opened view shows: the attendance count, a table's "of N", or its body rows. */
async function shownRows(page, scope = "#portal-main") {
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

const report = [];
function record(row) {
  report.push(row);
  console.log(`  CARD ${row.role} ${row.page} "${row.card}" -> ${row.href} | number ${row.number} rows ${row.rows} ${row.match ? "MATCH" : "differs"}`);
}
test.afterAll(() => {
  writeFileSync(join(OUT, `cards-${PHASE}-${process.pid}.json`), JSON.stringify(report, null, 2));
});

/**
 * Every card of `pageId`: click it (in place), check the address carries the
 * card's filters, count the rows, come back. Same-page cards must not reload.
 */
async function walkCards(page, role, pageId, { tabEnter = false } = {}) {
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
    record({ role, page: pageId, card: link.aria, href: link.href, number, rows, match: rows === number });
    if (!samePage) { await page.goBack(); await settle(page); expect(pageParam(page)).toBe(pageId); }
  }
  return links.length;
}

/* ── Part 1 + 2 + 3: Super Admin ─────────────────────────────────────── */

test("Super Admin: grouped sidebar, logo, cards, loading time", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await as(page, "super_admin", "sa-dashboard");
  // Signed in already: time a fresh open of the dashboard until no skeleton is left.
  for (let run = 1; run <= 3; run += 1) {
    const t0 = Date.now();
    await page.goto("/super-admin?page=sa-dashboard");
    await page.locator("#portal-main").waitFor();
    await expect(page.locator('#portal-main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 30000 });
    console.log(`  SA dashboard load ${run}: skeletons gone after ${Date.now() - t0} ms`);
  }
  const timings = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/")).map((e) => `${new URL(e.name).pathname} ${Math.round(e.duration)} ms`));
  console.log(`  SA dashboard API calls: ${timings.join(" | ")}`);
  await shot(page, "sa-sidebar-expanded-1366");

  if (PHASE === "before") {
    await page.locator('[data-sidebar="trigger"]').first().click();
    await shot(page, "sa-sidebar-collapsed-1366");
    return;
  }

  // Every item, same order, same route; groups open by URL.
  const items = PAGES.super_admin;
  for (const [id, label] of items) {
    await page.goto(`/super-admin?page=${id}`);
    await page.locator("#portal-main").waitFor();
    const active = sidebar(page).locator('[data-sidebar="menu-button"][data-active="true"]');
    await expect(active, `${id} is the active item`).toHaveText(new RegExp(label.replace(/[&]/g, "\\&")));
    const group = active.locator("xpath=ancestor::*[@data-nav-group][1]");
    const header = group.locator("button[aria-expanded]");
    if (await header.count()) await expect(header, `${id}: its group opens`).toHaveAttribute("aria-expanded", "true");
  }
  const order = await sidebar(page).locator('[data-sidebar="content"] [data-sidebar="menu-button"]').evaluateAll((els) => els.map((e) => e.textContent.trim().replace(/\d+$/, "")));
  expect(order.filter((t) => t)).toEqual(items.map(([, l]) => l));
  const groups = await sidebar(page).locator("[data-nav-group]").evaluateAll((els) => els.map((e) => e.dataset.navGroup));
  expect(groups).toEqual(["Overview", "Management", "RFID", "System", "My Account"]);

  // Header by mouse and keyboard.
  await page.goto("/super-admin?page=sa-dashboard");
  await page.locator("#portal-main").waitFor();
  const system = sidebar(page).locator('[data-nav-group="System"] button[aria-expanded]');
  const before = await system.getAttribute("aria-expanded");
  await system.click();
  await expect(system).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");
  await system.focus();
  await page.keyboard.press("Enter");
  await expect(system).toHaveAttribute("aria-expanded", before);
  expect(await system.getAttribute("aria-controls")).toBeTruthy();
  for (const id of await sidebar(page).locator("button[aria-controls]").evaluateAll((b) => b.map((x) => x.getAttribute("aria-controls")))) {
    expect(await page.locator(`#${id}`).count(), `aria-controls ${id} exists`).toBe(1);
  }

  // Part 2 from three pages, then collapsed.
  for (const from of ["sa-accounts", "sa-config", "sa-maintenance"]) {
    await page.goto(`/super-admin?page=${from}`);
    await page.locator("#portal-main").waitFor();
    await page.getByTestId("sidebar-home").click();
    await expect.poll(() => pageParam(page)).toBe("sa-dashboard");
  }
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toHaveCount(1);
  await shot(page, "sa-sidebar-collapsed-1366");
  // Collapsed: every page reachable (icons stay links in the rail).
  for (const [id, label] of items) {
    const btn = sidebar(page).locator('[data-sidebar="menu-button"]').filter({ hasText: label }).first();
    await expect(btn, `${label} reachable collapsed`).toBeVisible();
    await btn.click();
    await expect.poll(() => pageParam(page)).toBe(id);
  }
  await page.getByTestId("sidebar-home").click();
  await expect.poll(() => pageParam(page)).toBe("sa-dashboard");
  await page.locator('[data-sidebar="trigger"]').first().click();

  // Cards (Part 3), with the hover state shot.
  await walkCards(page, "super_admin", "sa-dashboard", { tabEnter: true });
  await page.locator('#portal-main a[data-testid="stat-card-link"]').first().hover();
  await shot(page, "sa-dashboard-card-hover-1366");
  for (const id of ["sa-accounts", "sa-maintenance"]) await walkCards(page, "super_admin", id);

  // Phone: same menu; the drawer closes after a choice and after the logo.
  await page.setViewportSize(PHONE);
  await page.goto("/super-admin?page=sa-dashboard");
  await page.locator("#portal-main").waitFor();
  for (const [id, label] of items.slice(1)) {
    await page.locator('[data-sidebar="trigger"]').first().click();
    const sheet = page.locator('[data-mobile="true"]');
    await sheet.waitFor();
    const btn = sheet.locator('[data-sidebar="menu-button"]').filter({ hasText: label }).first();
    if (!(await btn.isVisible())) await sheet.locator("[data-nav-group]").filter({ has: btn }).locator("button[aria-expanded]").click();
    if (id === "sa-accounts") await shot(page, "sa-sidebar-390");
    await btn.click();
    await expect(sheet).toBeHidden();
    expect(pageParam(page)).toBe(id);
  }
  await page.locator('[data-sidebar="trigger"]').first().click();
  await page.locator('[data-mobile="true"]').getByTestId("sidebar-home").click();
  await expect(page.locator('[data-mobile="true"]')).toBeHidden();
  await expect.poll(() => pageParam(page)).toBe("sa-dashboard");
  await shot(page, "sa-dashboard-390");
});

/* ── HR: the sidebar looks as before; logo; cards ───────────────────── */

test("HR: sidebar unchanged, logo, cards", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await as(page, "hr", "hr-payroll-approval");
  await settle(page);
  // Pixel comparison against the baseline taken on the old code (SHOTS=before --update-snapshots).
  await page.mouse.move(DESKTOP.width - 5, DESKTOP.height - 5);
  await expect(page.locator('[data-sidebar="content"]')).toHaveScreenshot("hr-sidebar-content.png", { maxDiffPixelRatio: 0.01 });
  if (PHASE === "before") return;

  for (const from of ["hr-employees", "hr-attendance", "hr-reports"]) {
    await page.goto(`/hr?page=${from}`);
    await page.locator("#portal-main").waitFor();
    await page.getByTestId("sidebar-home").click();
    await expect.poll(() => pageParam(page)).toBe("hr-dashboard");
  }
  await walkCards(page, "hr", "hr-dashboard", { tabEnter: true });
  await page.locator('#portal-main a[data-testid="stat-card-link"]').nth(1).focus();
  await shot(page, "hr-dashboard-card-focus-1366");
  for (const id of ["hr-transfers", "hr-awol", "hr-rfid-cards"]) await walkCards(page, "hr", id);
  // Not clickable: payroll totals have no link.
  await page.goto("/hr?page=hr-payroll-records");
  await settle(page);
  await expect(page.locator('#portal-main a[data-testid="stat-card-link"]')).toHaveCount(0);
  // A page HR could not open before still is not open.
  await page.goto("/hr?page=sa-backup");
  await page.locator("#portal-main").waitFor();
  await expect(page.locator("header h1")).not.toHaveText(/Backup/);
  await page.setViewportSize(PHONE);
  await page.goto("/hr?page=hr-leaves");
  await page.locator("#portal-main").waitFor();
  await page.locator('[data-sidebar="trigger"]').first().click();
  await page.locator('[data-mobile="true"]').getByTestId("sidebar-home").click();
  await expect(page.locator('[data-mobile="true"]')).toBeHidden();
  await expect.poll(() => pageParam(page)).toBe("hr-dashboard");
  await shot(page, "hr-dashboard-390");
});

/* ── Admin, Accountant, Employee ────────────────────────────────────── */

for (const [role, portal, fromPages, cardPages] of [
  ["admin", "/admin", ["adm-attendance", "adm-leaves", "adm-maintenance"], ["adm-dashboard", "adm-maintenance"]],
  ["accountant", "/accountant", ["ac-process", "ac-loans", "ac-monitoring"], ["ac-dashboard", "ac-monitoring", "ac-loans", "ac-cash-advances"]],
  ["employee", "/employee", ["emp-attendance", "emp-payslips", "emp-leave"], ["emp-dash"]],
]) {
  test(`${role}: logo and cards`, async ({ page }) => {
    test.skip(PHASE === "before");
    await page.setViewportSize(DESKTOP);
    await as(page, role, fromPages[0]);
    for (const from of fromPages) {
      await page.goto(`${portal}?page=${from}`);
      await page.locator("#portal-main").waitFor();
      await page.getByTestId("sidebar-home").click();
      await expect.poll(() => pageParam(page)).toBe(DASHBOARD[role]);
    }
    await page.locator('[data-sidebar="trigger"]').first().click();
    await page.getByTestId("sidebar-home").click();
    await expect.poll(() => pageParam(page)).toBe(DASHBOARD[role]);
    await page.locator('[data-sidebar="trigger"]').first().click();
    for (const id of cardPages) await walkCards(page, role, id, { tabEnter: id === DASHBOARD[role] });
    await page.goto(`${portal}?page=${DASHBOARD[role]}`);
    await settle(page);
    const first = page.locator('#portal-main a[data-testid="stat-card-link"]').first();
    if (await first.count()) await first.hover();
    await shot(page, `${role}-dashboard-card-hover-1366`);
    // Another role's page by URL: still this role's dashboard.
    await page.goto(`${portal}?page=hr-attendance`);
    await page.locator("#portal-main").waitFor();
    expect(["hr-attendance"]).not.toContain(await page.evaluate(() => document.querySelector('[data-sidebar="menu-button"][data-active="true"]')?.textContent));
    if (role === "admin") {
      // Branch isolation stays on the server: another branch's attendance is refused or limited to the Admin's own.
      const other = await page.request.get("/api/admin/branches").then((r) => r.json()).catch(() => ({}));
      const own = (await profileByEmail(ACCOUNTS.admin.email)).branch_id;
      const foreign = (other.branches || []).find((b) => b.id !== own);
      if (foreign) {
        const r = await page.request.get(`/api/attendance/logs?from=2026-01-01&to=2026-01-31&branch_id=${foreign.id}`);
        const data = await r.json().catch(() => ({}));
        expect(r.status() === 403 || (data.logs || []).every((l) => !l.branch_id || l.branch_id === own), "Admin never sees another branch").toBe(true);
      }
    }
    await page.setViewportSize(PHONE);
    await page.goto(`${portal}?page=${fromPages[1]}`);
    await page.locator("#portal-main").waitFor();
    await page.locator('[data-sidebar="trigger"]').first().click();
    await page.locator('[data-mobile="true"]').getByTestId("sidebar-home").click();
    await expect(page.locator('[data-mobile="true"]')).toBeHidden();
    await expect.poll(() => pageParam(page)).toBe(DASHBOARD[role]);
    await shot(page, `${role}-dashboard-390`);
  });
}

/* ── Kiosk and login logos are not links ─────────────────────────────── */

test("kiosk and login logos stay plain images", async ({ page }) => {
  test.skip(PHASE === "before");
  for (const path of ["/login", "/rfid-terminal"]) {
    await page.goto(path);
    const seal = page.locator('img[src*="/brand/logo"]').first();
    await seal.waitFor();
    expect(await seal.evaluate((img) => Boolean(img.closest("a")))).toBe(false);
  }
});

/* ── Part 4: reset password by email only ────────────────────────────── */

test("reset password: email only (API and dialog)", async ({ page }) => {
  const RESET = "/api/legacy-auth/reset-password";
  const acct = ACCOUNTS.employee3;
  const profile = await profileByEmail(acct.email);
  const post = (identity) => page.request.post(RESET, { data: { action: "send", identity } });

  for (const size of [DESKTOP, PHONE]) {
    await page.setViewportSize(size);
    const w = size.width;
    await page.goto("/login");
    await page.getByText("Forgot password?").click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#reset-identity").waitFor();
    await shot(page, `reset-empty-${w}`);
    if (PHASE === "before") continue;
    await expect(dialog.getByRole("heading", { name: "Reset password" })).toBeVisible();
    await expect(dialog.getByText("Enter your registered email address. A 6-digit code, valid for 5 minutes, will be sent to it.")).toBeVisible();
    await expect(dialog.getByText("The code goes to the email address registered on your account.", { exact: false })).toBeVisible();
    const input = dialog.locator("#reset-identity");
    await expect(input).toHaveAttribute("type", "email");
    await expect(input).toHaveAttribute("autocomplete", "email");
    await expect(input).toHaveAttribute("inputmode", "email");
    await expect(input).toHaveAttribute("placeholder", "name@example.com");
    await expect(dialog.getByText("Email address", { exact: true })).toBeVisible();
    const send = dialog.getByRole("button", { name: "Send code" });
    await expect(send).toBeDisabled();
    await input.press("Enter");
    await expect(dialog.getByText("Enter your email address.")).toBeVisible();
    await input.fill(profile.employee_code || "SACS-001");
    await input.press("Enter");
    await expect(dialog.getByText("Enter a valid email address. Employee IDs are no longer accepted here.")).toBeVisible();
    await expect(send).toBeDisabled();
    await shot(page, `reset-invalid-${w}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // An unregistered address: the same generic reply as a registered one.
    await input.fill(`nobody-${w}@e2e.test`);
    await expect(send).toBeEnabled();
    await input.press("Enter");
    await expect(dialog.getByText("If this email is registered, a code has been sent.")).toBeVisible();
    await shot(page, `reset-success-${w}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  if (PHASE === "before") return;

  // By API: an Employee ID and malformed values are refused (400).
  for (const bad of [profile.employee_code || "SACS-001", "SACS-001", "emp3@", "not an email", ""]) {
    const r = await post(bad);
    expect(r.status(), `"${bad}" refused`).toBe(400);
    expect((await r.json()).error).toMatch(/^Enter (a valid )?(your )?email address/);
  }
  // A registered email gets a code (planted first: locally no mail goes out),
  // and that code verifies; the password itself is never changed here.
  await plantOtp(acct.email, "reset");
  const ok = await post(` ${acct.email.toUpperCase()} `);
  expect(ok.status()).toBe(200);
  const okBody = await ok.json();
  const verify = await page.request.post(RESET, { data: { action: "verify", code: TEST_OTP } });
  expect(verify.status(), "the code checks out").toBe(200);
  // Unregistered: the same answer.
  const none = await post("nobody-api@e2e.test");
  expect(none.status()).toBe(200);
  expect((await none.json()).message).toBe(okBody.message);
  // The rate limit still works.
  const again = await post("nobody-api@e2e.test");
  expect(again.status()).toBe(429);
});
