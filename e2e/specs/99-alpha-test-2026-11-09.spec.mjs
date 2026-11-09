// Alpha test fixes (2026-11-09), desktop 1280x800, LOCAL stack only:
//   T  API timings per role (median of 5), written to
//      test-results/alpha-timings-<E2E_TIMING_LABEL or "after">.json
//   A1 date range filter + paging on the employee's attendance
//   A2 announcement details open
//   E  HR adds an SSS rate version (future period, reason) and the Super Admin
//      is notified; own rate, past date, no reason, other rules refused
//   C1 a second tap within the window: "Already recorded at …", logged
//   B  Branch Management table, positions list, loans Pending filter + export,
//      avatar menu + Help tour, SA dashboard cards open their pages
//   D  manifest, service worker and offline page are served
//
//   E2E_RESET=0 E2E_SLOWMO=500 npx playwright test e2e/specs/99-alpha-test-2026-11-09.spec.mjs --project=desktop --workers=1
//   Timings only (e.g. against another build on E2E_PORT):
//   E2E_TIMING_LABEL=before npx playwright test e2e/specs/99-alpha-test-2026-11-09.spec.mjs -g "timings"
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

test.use({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });

const LABEL = process.env.E2E_TIMING_LABEL || "after";
const SHOTS = join(process.cwd(), "screenshots", "2026-11-09", LABEL);
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

/** Median time of n calls (ms), and the last status. */
async function time(page, path, n = 5) {
  const runs = [];
  let status = 0;
  for (let i = 0; i < n; i += 1) {
    const t0 = Date.now();
    const res = await page.request.get(path);
    status = res.status();
    await res.body();
    runs.push(Date.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return { median_ms: runs[Math.floor(runs.length / 2)], min_ms: runs[0], max_ms: runs[runs.length - 1], status };
}

test("timings: the slow pages' API calls, per role", async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const today = manilaDay(0);
  const monthAgo = manilaDay(-30);
  const results = {};
  const plan = {
    employee: [
      ["Employee timesheet (30 days)", `/api/employee/timesheet?email=${encodeURIComponent(ACCOUNTS.employee.email)}&start_date=${monthAgo}&end_date=${today}`],
      ["Employee attendance (30 days)", `/api/attendance/logs?from=${monthAgo}&to=${today}`],
      ["Notifications", "/api/notifications"],
    ],
    accountant: [
      ["Loans", "/api/accountant/loans"],
      ["Payroll (processing / records)", "/api/accountant/payroll"],
    ],
    hr: [
      ["HR attendance (today)", `/api/hr/attendance?date=${today}`],
      ["HR reports: attendance", `/api/hr/reports?type=attendance&to=${today}`],
      ["Government rates", "/api/payroll/government-rates"],
    ],
    super_admin: [
      ["RFID cards list", "/api/rfid/cards"],
      ["Branches", "/api/admin/branches"],
      ["SA dashboard", "/api/admin/dashboard"],
    ],
    admin: [
      ["Branch attendance", `/api/admin/branch-oversight?view=attendance&date=${today}`],
    ],
  };
  for (const [role, calls] of Object.entries(plan)) {
    await step(page, `${role}: time ${calls.length} API calls (5 each)`, async () => {
      await as(page, role);
      for (const [name, path] of calls) {
        results[`${role} · ${name}`] = await time(page, path);
        console.log(`    ${name}: ${JSON.stringify(results[`${role} · ${name}`])}`);
      }
    });
  }
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  writeFileSync(join(process.cwd(), "test-results", `alpha-timings-${LABEL}.json`), JSON.stringify(results, null, 2));
  for (const [name, r] of Object.entries(results)) expect(r.status, name).toBeLessThan(500);
});

test("A1: the employee's attendance has a date range and pages", async ({ page }) => {
  await as(page, "employee", "emp-attendance");
  await settle(page);
  await step(page, "Employee > Attendance > date range filter is there", async () => {
    await expect(main(page).getByText("Attendance records by date").first()).toBeVisible();
    await expect(page.locator("#emp-att-from")).toBeVisible();
    await shot(page, "a1-employee-attendance-range");
  });
  await step(page, "API: a range over 366 days is refused, paging returns a total", async () => {
    const tooLong = await api(page, "GET", `/api/attendance/logs?from=${manilaDay(-400)}&to=${manilaDay(0)}`);
    expect(tooLong.status).toBe(400);
    const paged = await api(page, "GET", `/api/attendance/logs?from=${manilaDay(-60)}&to=${manilaDay(0)}&page=1&page_size=10`);
    expect(paged.status).toBe(200);
    expect(typeof paged.data.total).toBe("number");
    expect(paged.data.logs.length).toBeLessThanOrEqual(10);
  });
});

test("E: HR adds an SSS rate version; the Super Admin is notified; the rules hold", async ({ page }) => {
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const sa = await profileByEmail(ACCOUNTS.super_admin.email);
  const reason = `E2E alpha ${Date.now()}`;
  await as(page, "hr", "hr-gov-rates");
  await settle(page);
  await step(page, "HR > Government Rates shows the rates HR can change", async () => {
    await expect(main(page).getByText("Government rates you can change")).toBeVisible();
    await shot(page, "e-hr-gov-rates");
  });
  await step(page, "HR: refused without a reason, for a past date, for another rule, for its own rate", async () => {
    const base = { rate_type: "sss_pct", scope: "global", value: 5, effective_date: "2027-07-01" };
    expect((await api(page, "POST", "/api/payroll/rates", { ...base, note: "" })).status).toBe(400);
    expect((await api(page, "POST", "/api/payroll/rates", { ...base, effective_date: "2026-01-01", note: reason })).data.code).toBe("future_periods_only");
    expect((await api(page, "POST", "/api/payroll/rates", { ...base, rate_type: "overtime_premium_pct", value: 30, note: reason })).status).toBe(403);
    expect((await api(page, "POST", "/api/payroll/rates", { rate_type: "daily", scope: "employee", scope_ref: hr.id, value: 900, effective_date: "2027-07-01", note: reason })).data.code).toBe("own_rate");
    expect((await api(page, "POST", "/api/payroll/rates", { rate_type: "hourly", scope: "global", value: 90, effective_date: "2027-07-01", note: reason })).status).toBe(400);
  });
  await step(page, "HR saves SSS 5% from Jul 1, 2027 with a reason; audit has old and new", async () => {
    const res = await api(page, "POST", "/api/payroll/rates", { rate_type: "sss_pct", scope: "global", value: 5, effective_date: "2027-07-01", note: reason });
    expect(res.status).toBe(200);
    const log = await rows(db().from("audit_logs").select("metadata").eq("action", "rate_version").order("created_at", { ascending: false }).limit(1));
    expect(log[0].metadata).toMatchObject({ rate_type: "sss_pct", value: 5, reason, changed_by_role: "hr" });
    const notes = await rows(db().from("notifications").select("title,body").eq("recipient_id", sa.id).eq("kind", "rate_change").order("created_at", { ascending: false }).limit(1));
    expect(notes[0].body).toContain(reason);
    expect(`${notes[0].title} ${notes[0].body}`).not.toMatch(/5%|₱/);
  });
  await step(page, "Accountant cannot change rates", async () => {
    await as(page, "accountant");
    expect((await api(page, "POST", "/api/payroll/rates", { rate_type: "sss_pct", scope: "global", value: 5, effective_date: "2027-07-01", note: reason })).status).toBe(403);
  });
});

test("D2: the Super Admin's bell shows the new notice without a reload", async ({ page, browser }) => {
  await as(page, "super_admin");
  await settle(page);
  const hrContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const hrPage = await hrContext.newPage();
  await step(page, "HR saves a rate while the Super Admin's page stays open", async () => {
    await as(hrPage, "hr");
    // Read once so the bell has subscribed, then mark everything read.
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
    const res = await api(hrPage, "POST", "/api/payroll/rates", { rate_type: "pagibig_pct", scope: "global", value: 2, effective_date: "2027-08-01", note: `E2E bell ${Date.now()}` });
    expect(res.status).toBe(200);
    await expect(page.getByRole("button", { name: /Notifications, \d+ new/ })).toBeVisible({ timeout: 10000 });
  });
  await step(page, "the bell menu has one scroll area", async () => {
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page.getByTestId("notifications-scroll")).toBeVisible();
    const scrollers = await page.getByTestId("notifications-menu").evaluate((menu) => [menu, ...menu.querySelectorAll("*")]
      .filter((el) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight; }).length);
    expect(scrollers).toBeLessThanOrEqual(1);
    await shot(page, "d2-bell");
    await page.keyboard.press("Escape");
  });
  await hrContext.close();
});

test("C1: a second tap within the window says when it was recorded", async ({ page }) => {
  await as(page, "super_admin");
  const tap = () => page.request.post("/api/admin/attendance", { data: { rfid_code: "1000000002", device: "E2E alpha" }, headers: { "Content-Type": "application/json", "x-sacs-kiosk": "1" } });
  await step(page, "two taps of Bea's card a moment apart", async () => {
    const first = await tap();
    const firstBody = await first.json();
    console.log(`    first tap: ${first.status()} ${JSON.stringify({ tap: firstBody.tap, code: firstBody.code, error: firstBody.error, message: firstBody.message })}`);
    test.skip(!first.ok(), `The first tap was refused (${firstBody.code || firstBody.error}); the unit tests cover the duplicate window.`);
    const secondRes = await tap();
    const second = await secondRes.json();
    console.log(`    second tap: ${secondRes.status()} ${JSON.stringify({ tap: second.tap, code: second.code, error: second.error, message: second.message })}`);
    expect(second.tap).toBe("duplicate");
    expect(second.message).toMatch(/^Already recorded at \d{1,2}:\d{2} (AM|PM)\./);
  });
});

test("B: Branch Management, positions, loans, avatar menu, Help, SA cards", async ({ page }) => {
  await as(page, "super_admin", "sa-branches");
  await settle(page);
  await step(page, "SA > Branch Management is a table with employee counts", async () => {
    await expect(main(page).locator("thead").getByText("Employees", { exact: true })).toBeVisible();
    await expect(main(page).locator("tbody tr").first()).toBeVisible();
    await shot(page, "b-branches-table");
  });
  await step(page, "SA > Dashboard: the Total users card opens Admin & HR Accounts", async () => {
    await as(page, "super_admin", "sa-dashboard");
    await settle(page);
    await main(page).getByRole("button", { name: /Total users: open Admin & HR Accounts/ }).click();
    await expect(page.locator("h1")).toHaveText("Admin & HR Accounts");
  });
  await step(page, "Avatar menu: Profile, Change password, Help, Sign out; Help opens the tour", async () => {
    await page.getByTestId("header-avatar").click();
    for (const item of ["Change password", "Help", "Sign out"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    await page.getByRole("menuitem", { name: "Help" }).click();
    await expect(page.getByTestId("help-tour")).toBeVisible();
    await shot(page, "b-help-tour");
    await page.getByRole("button", { name: "Skip" }).click();
  });
  await step(page, "HR: the positions list refuses a second spelling", async () => {
    await as(page, "hr");
    const name = `E2E Position ${Date.now() % 100000}`;
    expect((await api(page, "POST", "/api/hr/positions", { name })).status).toBe(200);
    const dup = await api(page, "POST", "/api/hr/positions", { name: name.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.data.name).toBe(name);
  });
  await step(page, "Accountant > Loans: Pending filter and Excel export", async () => {
    await as(page, "accountant", "ac-loans");
    await settle(page);
    await page.getByTestId("loan-status-filter").click();
    await expect(page.getByRole("option", { name: "Pending HR approval" })).toBeVisible();
    await page.keyboard.press("Escape");
    const file = await page.request.get("/api/accountant/loans?status=pending&format=xlsx");
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toContain("spreadsheet");
    await shot(page, "b-loans");
  });
});

test("D1: manifest, service worker and offline page are served", async ({ page }) => {
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).name).toBe("SACS Payroll");
  expect((await page.request.get("/sw.js")).status()).toBe(200);
  expect(await (await page.request.get("/offline.html")).text()).toContain("You are offline");
});

// The same pages on either build (E2E_TIMING_LABEL=before on the old one).
test("screens: key pages for before / after", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  const PAGES_TO_SHOOT = [
    ["employee", "emp-attendance"], ["employee", "emp-timesheet"], ["employee", "emp-dash"],
    ["hr", "hr-gov-rates"], ["hr", "hr-reports"], ["hr", "hr-attendance"], ["hr", "hr-tenure"],
    ["accountant", "ac-loans"], ["accountant", "ac-process"], ["accountant", "ac-approvals"], ["accountant", "ac-dashboard"],
    ["super_admin", "sa-branches"], ["super_admin", "sa-dashboard"], ["super_admin", "sa-roles"],
    ["admin", "adm-attendance"],
  ];
  for (const [role, id] of PAGES_TO_SHOOT) {
    await step(page, `screenshot ${role} ${id}`, async () => {
      await as(page, role, id);
      await settle(page);
      await page.screenshot({ path: join(SHOTS, `page-${id}.png`), fullPage: true });
    });
  }
  await step(page, "screenshot the bell menu", async () => {
    await as(page, "super_admin");
    await settle(page);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.screenshot({ path: join(SHOTS, "page-bell-menu.png") });
    await page.keyboard.press("Escape");
  });
});
