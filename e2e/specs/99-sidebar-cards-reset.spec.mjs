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
import { saveReport, walkCards } from "../support/cards.mjs";

test.describe.configure({ mode: "parallel" });

const PHASE = process.env.SHOTS || "after";
const OUT = join(process.cwd(), "screenshots", "2026-11-14-sidebar-cards-reset");
mkdirSync(join(OUT, PHASE), { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: join(OUT, PHASE, `${name}.png`), ...opts });
const DESKTOP = { width: 1366, height: 800 };
const PHONE = { width: 390, height: 844 };
const ADMIN_ITEMS = [
  ["adm-dashboard", "Dashboard"], ["adm-attendance", "Branch Attendance"], ["adm-overtime", "Overtime & Substitute"],
  ["adm-leaves", "Leave Recommendations"], ["adm-transfers", "Transfer Endorsements"], ["adm-incentives", "Incentive Recommendations"], ["adm-schedules", "Schedule Requests"],
  ["adm-incidents", "Incident & AWOL Reports"], ["adm-rfid-issues", "RFID Issues"],
  ["adm-announcements", "Announcements"], ["adm-payroll", "Payroll Summary"], ["adm-branch-reports", "Branch Reports"], ["adm-pay-rates", "Pay Rates"],
  ["adm-maintenance", "RFID Terminal & Cards"], ["adm-profile", "Profile"],
];
const DASHBOARD = { super_admin: "sa-dashboard", admin: "adm-dashboard", hr: "hr-dashboard", accountant: "ac-dashboard", employee: "emp-dash" };

const pageParam = (page) => new URL(page.url()).searchParams.get("page");
const sidebar = (page) => page.locator('[data-slot="sidebar-container"]');
// Part I (2026-11-23, approved map): one sidebar item per module; each page is a tab of it.
const SA_MODULES = ["Dashboard", "Accounts", "Branches", "Attendance Records", "RFID", "System", "Audit & Monitoring", "My Account"];
const ADMIN_MODULES = ["Dashboard", "Branch Attendance", "Branch Review", "Incidents & RFID", "My Account"];
/** The page opens with its module active in the sidebar and (when the module has tabs) its own tab current. */
async function expectOpenAt(page, id) {
  const active = page.locator('[data-slot="sidebar-container"] [data-sidebar="menu-button"][data-active="true"]');
  await expect(active, `${id}: its module is the active item`).toHaveCount(1);
  expect((await active.getAttribute("data-tabs")).split(" "), `${id}: the active module holds it`).toContain(id);
  if (await page.locator("[data-module-tabs] a").count()) {
    await expect(page.locator(`[data-module-tabs] a[data-tab="${id}"]`), `${id}: its tab is current`).toHaveAttribute("aria-current", "page");
  }
}


test.afterAll(() => saveReport(OUT, `cards-${PHASE}`));

/* ── Part 1 + 2 + 3: Super Admin ─────────────────────────────────────── */

test("Super Admin: module sidebar with tabs, logo, cards, loading time", async ({ page }) => {
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

  // Part I (2026-11-23, approved map): every page keeps its route and opens in its module, on its tab.
  const items = PAGES.super_admin;
  for (const [id] of items) {
    await page.goto(`/super-admin?page=${id}`);
    await page.locator("#portal-main").waitFor();
    await expectOpenAt(page, id);
  }
  const order = await sidebar(page).locator('[data-sidebar="content"] [data-sidebar="menu-button"]').evaluateAll((els) => els.map((e) => e.textContent.trim().replace(/\d+$/, "")));
  expect(order.filter((t) => t)).toEqual(SA_MODULES);
  const groups = await sidebar(page).locator("[data-nav-group]").evaluateAll((els) => els.map((e) => e.dataset.navGroup));
  expect(groups).toEqual(["Overview", "Management", "My Account"]);

  // Tabs by mouse and keyboard: each tab is a link to its page.
  await page.goto("/super-admin?page=sa-dashboard");
  await page.locator("#portal-main").waitFor();
  await page.locator('[data-module-tabs] a[data-tab="sa-announcements"]').click();
  await expect.poll(() => pageParam(page)).toBe("sa-announcements");
  await page.locator('[data-module-tabs] a[data-tab="sa-fallback"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => pageParam(page)).toBe("sa-fallback");

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
  // Collapsed: every module reachable (icons stay links in the rail); it opens on its first tab.
  for (const label of SA_MODULES) {
    const btn = sidebar(page).locator('[data-sidebar="menu-button"]').filter({ hasText: label }).first();
    await expect(btn, `${label} reachable collapsed`).toBeVisible();
    const first = (await btn.getAttribute("data-tabs")).split(" ")[0];
    await btn.click();
    await expect.poll(() => pageParam(page)).toBe(first);
  }
  await page.getByTestId("sidebar-home").click();
  await expect.poll(() => pageParam(page)).toBe("sa-dashboard");
  await page.locator('[data-sidebar="trigger"]').first().click();

  // Cards (Part 3), with the hover state shot.
  await walkCards(page, "super_admin", "sa-dashboard", { tabEnter: true });
  await page.locator('#portal-main a[data-testid="stat-card-link"]').first().hover();
  await shot(page, "sa-dashboard-card-hover-1366");
  for (const id of ["sa-accounts", "sa-maintenance"]) await walkCards(page, "super_admin", id);
  // Total employees, Total users and System status are not links (decision 2026-11-14).
  await page.goto("/super-admin?page=sa-dashboard");
  await settle(page);
  for (const label of ["Total employees", "Total users", "System status"]) {
    await expect(page.locator('#portal-main a[data-testid="stat-card-link"]').filter({ hasText: label })).toHaveCount(0);
  }

  // "Items waiting on fallback" is a Dashboard tab: shown in full (no "…"), at 1366 and at 390.
  const fallbackTab = async () => page.locator('[data-module-tabs] a[data-tab="sa-fallback"]').evaluate((a) => ({
    cut: a.scrollWidth > a.clientWidth + 1, text: a.textContent.trim().replace(/\d+$/, "").trim(),
  }));
  expect(await fallbackTab(), "1366: the fallback tab in full").toEqual({ cut: false, text: "Items waiting on fallback" });
  await page.locator("[data-module-tabs]").screenshot({ path: join(OUT, PHASE, "sa-fallback-label-1366.png") });

  // The badge follows a decision at once, on the Dashboard item (summed) and on its tab (mocked item: the local data has none).
  let total = 1;
  await page.route("**/api/super-admin/fallback", (route) => (route.request().method() === "POST"
    ? (total = 0, route.fulfill({ json: { ok: true } }))
    : route.fulfill({ json: { counts: { total }, items: total ? [{ id: "mock-1", item_type: "leave", title: "Mock leave", detail: "", reason: "No other HR active", submitted_at: "2026-11-14" }] : [] } })));
  await page.goto("/super-admin?page=sa-fallback");
  await page.locator("#portal-main").waitFor();
  const badge = sidebar(page).locator('[data-sidebar="menu-badge"]');
  await expect(badge).toHaveText("1");
  await expect(page.locator('[data-module-tabs] a[data-tab="sa-fallback"]')).toContainText("1");
  await page.getByRole("button", { name: "Approve" }).click();
  // Part H: the decision opens its remark dialog (a remark is optional to approve).
  await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(badge).toHaveCount(0);
  await page.unroute("**/api/super-admin/fallback");

  // Phone: same menu; the drawer closes after a choice and after the logo.
  await page.setViewportSize(PHONE);
  await page.goto("/super-admin?page=sa-dashboard");
  await page.locator("#portal-main").waitFor();
  for (const label of SA_MODULES.slice(1)) {
    await page.locator('[data-sidebar="trigger"]').first().click();
    const sheet = page.locator('[data-mobile="true"]');
    await sheet.waitFor();
    const btn = sheet.locator('[data-sidebar="menu-button"]').filter({ hasText: label }).first();
    const first = (await btn.getAttribute("data-tabs")).split(" ")[0];
    if (label === "Accounts") await shot(page, "sa-sidebar-390");
    await btn.click();
    await expect(sheet).toBeHidden();
    expect(pageParam(page)).toBe(first);
  }
  await page.locator('[data-sidebar="trigger"]').first().click();
  await page.locator('[data-mobile="true"]').getByTestId("sidebar-home").click();
  await expect(page.locator('[data-mobile="true"]')).toBeHidden();
  await expect.poll(() => pageParam(page)).toBe("sa-dashboard");
  await shot(page, "sa-dashboard-390");
  // 390: the tab bar scrolls sideways itself; the page does not, and the fallback tab is not cut.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "390: no sideways page scroll").toBe(true);
  expect(await fallbackTab(), "390: the fallback tab in full").toEqual({ cut: false, text: "Items waiting on fallback" });
  await shot(page, "sa-fallback-label-390");
});

/* ── HR: the sidebar matches its baseline (re-recorded for Part I); logo; cards ── */

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
    if (role === "accountant") {
      // Basic salary (2026-11-14): the contract's monthly pay, the same in both halves;
      // each half's "Basic pay" line is computed from it.
      await page.goto("/accountant?page=ac-process");
      await settle(page);
      // The same full-month employee in both halves, picked by name AFTER the period: choosing a period
      // opens that period's first saved draft, which can belong to someone else (full run 2026-11-24).
      const pickAna = async () => {
        await page.locator("#pc-employee").click();
        await page.getByRole("option", { name: /^Ana Lopez/ }).first().click();
        await settle(page);
      };
      await pickAna();
      const shownBasic = [];
      const offered = await page.locator("#pc-period").click().then(() => page.getByRole("option").allInnerTexts());
      await page.keyboard.press("Escape");
      // The current month's two halves, by name (always offered). "The first two in the list" depended on today's
      // date and on which periods other specs had touched last: 99-sa-backup-ui-rates plants a paid September 16-30
      // payslip with an empty computation, which then came first (root cause found 2026-11-23).
      const now = new Date(Date.now() + 8 * 3600e3);
      const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const options = [`${month} 1-15, ${now.getUTCFullYear()}`, `${month} 16-${lastDay}, ${now.getUTCFullYear()}`];
      for (const label of options) expect(offered, `${label} is offered`).toContain(label);
      for (const period of options) {
        await page.locator("#pc-period").click();
        await page.getByRole("option", { name: period, exact: true }).click();
        await settle(page);
        await pickAna();
        // Shown as "32,000.00" with ₱ inside the field (cleanup 2026-11-14).
        const basic = Number((await page.locator("#pc-basic").inputValue()).replace(/,/g, ""));
        const summaryCard = page.locator('[data-slot="card"]').filter({ hasText: "Computation summary" }).first();
        const line = summaryCard.getByText(/^Basic (pay|salary) \(/).first();
        await expect(line, `${period}: the summary names the half's Basic pay`).toHaveText(/Basic pay \((1st|2nd) half\)|Basic salary \(whole month\)/);
        // The line's formula starts from the monthly Basic salary: "₱32,000 ÷ 2", "₱32,000 − ₱16,000 (1st half)", "₱32,000 a month".
        await expect(summaryCard.getByText(new RegExp(`^₱${basic.toLocaleString("en-PH")}(\\.00)? (÷ 2|−|a month)`)).first(), `${period}: worked out from the same Basic salary`).toBeVisible();
        shownBasic.push(basic);
        await page.screenshot({ path: join(OUT, PHASE, `basic-salary-${/1-15/.test(period) ? "1st" : "2nd"}-half.png`), fullPage: false });
      }
      expect(shownBasic.length).toBe(2);
      // Batch table header (label only, cleanup 2026-11-14): "Basic pay" in a 1st half, "Gross (this payslip)" in a 2nd half.
      const batch = page.getByTestId("batch-card");
      for (const period of options.filter((o) => /1-15|16-3[01]/.test(o)).slice(0, 2)) {
        await batch.getByRole("combobox", { name: "Pay period" }).click();
        await page.getByRole("option", { name: period, exact: true }).click();
        await settle(page);
        const first = /1-15/.test(period);
        await expect(batch.locator("thead th").nth(2)).toHaveText(first ? "Basic pay" : "Gross (this payslip)");
        for (const [w, h] of [[1366, 800], [390, 844]]) {
          await page.setViewportSize({ width: w, height: h });
          await batch.scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${w}px: the page does not scroll sideways`).toBe(true);
          await batch.screenshot({ path: join(OUT, PHASE, `batch-header-${first ? "1st" : "2nd"}-half-${w}.png`) });
        }
        await page.setViewportSize(DESKTOP);
      }
      expect(shownBasic[0], "Basic salary is the same in both halves").toBe(shownBasic[1]);
      expect(shownBasic[0]).toBeGreaterThan(0);
    }
    if (role === "admin") {
      // Collapsible groups (decision 2026-11-14): every item, same order, same route; a URL opens its group.
      // Part I: every page keeps its route and opens in its module, on its tab; five modules.
      for (const [id] of ADMIN_ITEMS) {
        await page.goto(`/admin?page=${id}`);
        await page.locator("#portal-main").waitFor();
        await expectOpenAt(page, id);
      }
      const order = await sidebar(page).locator('[data-sidebar="content"] [data-sidebar="menu-button"]').evaluateAll((els) => els.map((e) => e.textContent.trim().replace(/\d+$/, "")));
      expect(order).toEqual(ADMIN_MODULES);
      expect(await sidebar(page).locator("[data-nav-group]").evaluateAll((els) => els.map((e) => e.dataset.navGroup)))
        .toEqual(["Overview", "Branch", "My Account"]);
      await page.goto("/admin?page=adm-dashboard");
      await settle(page);
      await shot(page, "admin-sidebar-1366");
    }
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
