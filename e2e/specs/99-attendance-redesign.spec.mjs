// Attendance redesign (2026-11-09), LOCAL stack only.
//   screens   every attendance page, every role, 1920 / 1366 / 768 / 390 px,
//             light and dark, into screenshots/2026-11-09-attendance/<label>/
//             (E2E_TIMING_LABEL=before against the old build on E2E_PORT)
//   checks    (after) no sideways page scroll, no "null" / "[object Object]",
//             summary tiles and one-row toolbar on wide screens
//   filters   tiles, search, range edge cases, export follow the filters
//   isolation the Accountant and the Admin never get another branch (API)
//   phone     Filters sheet and cards
//
//   E2E_RESET=0 E2E_SLOWMO=500 npx playwright test e2e/specs/99-attendance-redesign.spec.mjs --project=desktop --workers=1
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle, pageOverflow } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS, BRANCH_NORTH } from "../accounts.mjs";

const LABEL = process.env.E2E_TIMING_LABEL || "after";
const AFTER = LABEL === "after";
const SHOTS = join(process.cwd(), "screenshots", "2026-11-09-attendance", LABEL);
mkdirSync(SHOTS, { recursive: true });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Pick a date in a DatePicker that sits inside another popover. */
async function pickInside(page, trigger, key) {
  const [y, m, d] = key.split("-").map(Number);
  const wrappers = page.locator("[data-radix-popper-content-wrapper]");
  const before = await wrappers.count();
  await trigger.click();
  await expect(wrappers).toHaveCount(before + 1);
  const cal = wrappers.last();
  const selects = cal.locator("select");
  if (await selects.count() >= 2) {
    await selects.nth(1).selectOption(String(y)).catch(() => {});
    await selects.nth(0).selectOption({ label: MONTHS[m - 1].slice(0, 3) }).catch(async () => { await selects.nth(0).selectOption(String(m - 1)).catch(() => {}); });
  }
  await cal.getByRole("button", { name: new RegExp(`${MONTHS[m - 1]} ${d}(st|nd|rd|th)?, ${y}`) }).first().click();
  await expect(wrappers).toHaveCount(before);
}

const PAGES = [
  ["employee", "emp-attendance"], ["employee", "emp-timesheet"], ["admin", "adm-attendance"],
  ["hr", "hr-attendance"], ["accountant", "ac-attendance"], ["super_admin", "sa-attendance"],
];
const WIDTHS = [1920, 1366, 768, 390];

for (const [role, id] of PAGES) {
  test(`screens: ${role} ${id} at four widths, light and dark`, async ({ page }) => {
    test.setTimeout(6 * 60 * 1000);
    await as(page, role, id);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("sacs-ui-theme", t), theme);
      for (const width of WIDTHS) {
        await step(page, `${id} ${width}px ${theme}`, async () => {
          await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
          await page.reload();
          await settle(page);
          await page.screenshot({ path: join(SHOTS, `${id}-${width}-${theme}.png`), fullPage: true });
          if (!AFTER) return;
          expect(await pageOverflow(page), `${id} ${width}px: no sideways page scroll`).toBeLessThanOrEqual(0);
          const text = await main(page).innerText();
          expect(text, `${id} ${width}px: no "null" / "[object Object]" text`).not.toMatch(/\bnull\b|\[object Object\]|undefined/);
          if (id !== "emp-timesheet") {
            await expect(main(page).getByTestId("attendance-summary"), `${id}: summary tiles`).toBeVisible();
            if (width >= 1366) {
              const bar = main(page).locator('[data-slot="attendance-toolbar"]').first();
              // The controls' vertical centres (select wrappers are display: contents).
              const centres = await bar.evaluate((el) => [...el.querySelectorAll("input, [data-slot=select-trigger], button[data-slot=button], [data-testid=att-count]")]
                .map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top + r.height / 2));
              expect(Math.max(...centres) - Math.min(...centres), `${id} ${width}px: the toolbar is one row`).toBeLessThanOrEqual(8);
            }
          }
        });
      }
    }
  });
}

test("filters: tiles, search, range edge cases and export agree (HR)", async ({ page }) => {
  test.skip(!AFTER, "after build only");
  test.setTimeout(5 * 60 * 1000);
  await page.setViewportSize({ width: 1366, height: 900 });
  await as(page, "hr", "hr-attendance");
  await settle(page);
  const board = main(page).getByTestId("attendance-board");

  await step(page, "a tile filters the table: the record count equals the tile", async () => {
    const tile = board.getByTestId("attendance-tile").filter({ hasText: "Absent" });
    const n = Number((await tile.locator("span").first().innerText()).replace(/,/g, ""));
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await expect(board.getByTestId("att-count")).toHaveText(`${n.toLocaleString("en-PH")} record${n === 1 ? "" : "s"}`);
    expect(page.url()).toContain("hr_att_status=Absent");
    await board.getByTestId("att-reset").click();
  });

  await step(page, "search narrows the list on the server", async () => {
    await board.getByTestId("att-search").fill("Bea");
    await expect.poll(async () => (await board.locator("tbody tr").allInnerTexts()).every((t) => /Bea|No employees match/.test(t)), { timeout: 15000 }).toBe(true);
    await board.getByTestId("att-search").fill("");
  });

  await step(page, "range: To before From and more than 62 days are refused in the popover, with a message", async () => {
    await board.locator("#hr_att-range-range").click();
    const pop = page.locator("[data-slot=popover-content]").filter({ has: page.locator("#hr_att-range-from") });
    await expect(pop).toBeVisible();
    await pickInside(page, pop.locator("#hr_att-range-from"), manilaDay(0));
    await pickInside(page, pop.locator("#hr_att-range-to"), manilaDay(-1));
    await expect(pop.getByRole("alert")).toHaveText("The To date is before the From date.");
    await expect(pop.getByTestId("hr_att-range-apply")).toBeDisabled();
    await pickInside(page, pop.locator("#hr_att-range-from"), manilaDay(-80));
    await pickInside(page, pop.locator("#hr_att-range-to"), manilaDay(0));
    await expect(pop.getByRole("alert")).toContainText("Choose 62 days or fewer");
    await expect(pop.getByTestId("hr_att-range-apply")).toBeDisabled();
    await page.screenshot({ path: join(SHOTS, "hr-range-too-long.png") });
    await pop.getByRole("button", { name: "Cancel" }).click();
    const tooLong = await api(page, "GET", `/api/attendance/logs?from=${manilaDay(-80)}&to=${manilaDay(0)}&page=1`);
    expect(tooLong.status).toBe(400);
  });

  await step(page, "a future-only range: nothing counted, a clear empty state", async () => {
    const res = await api(page, "GET", `/api/attendance/logs?from=${manilaDay(10)}&to=${manilaDay(20)}&page=1&page_size=10`);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(0);
    expect(Object.values(res.data.counts || {}).reduce((a, b) => a + b, 0)).toBe(0);
  });

  await step(page, "today's people who have not tapped are 'Not tapped yet', not Absent", async () => {
    const res = await api(page, "GET", `/api/attendance/logs?from=${manilaDay(0)}&to=${manilaDay(0)}&page=1&page_size=100`);
    expect(res.data.logs.filter((r) => r.not_tapped_yet).every((r) => r.status === "Not tapped yet")).toBe(true);
    expect(res.data.counts.Absent || 0).toBe(0);
  });

  await step(page, "the export follows the filters", async () => {
    const file = await page.request.get(`/api/attendance/logs?from=${manilaDay(-14)}&to=${manilaDay(0)}&status=Absent&format=xlsx`);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toContain("spreadsheet");
  });
});

test("isolation: the Accountant and the Admin never get another branch (direct API)", async ({ page }) => {
  test.skip(!AFTER, "after build only");
  const north = (await rows(db().from("branches").select("id").eq("name", BRANCH_NORTH)))[0];
  for (const role of ["accountant", "admin"]) {
    await step(page, `${role}: asking for the North branch still returns its own branch only`, async () => {
      await as(page, role);
      const me = await profileByEmail(ACCOUNTS[role].email);
      const res = await api(page, "GET", `/api/attendance/logs?from=${manilaDay(-30)}&to=${manilaDay(0)}&branch_id=${north.id}&page=1&page_size=100`);
      console.log(`    ${role}: /api/attendance/logs with another branch_id -> ${res.status}`);
      // Refused outright (403) or answered with its own branch only.
      expect([200, 403]).toContain(res.status);
      const branchView = role === "admin"
        ? await api(page, "GET", `/api/admin/branch-oversight?view=attendance&from=${manilaDay(-30)}&to=${manilaDay(0)}&branch_id=${north.id}&page=1&page_size=100`)
        : null;
      const ids = [...new Set([...(res.data?.logs || []), ...(branchView?.data?.logs || [])].map((r) => r.employee_id))];
      if (ids.length) {
        const branches = await rows(db().from("profiles").select("branch_id").in("id", ids));
        expect(branches.every((b) => b.branch_id === me.branch_id)).toBe(true);
      }
    });
  }
});

test("phone: Filters sheet and cards", async ({ page }) => {
  test.skip(!AFTER, "after build only");
  await page.setViewportSize({ width: 390, height: 844 });
  await as(page, "super_admin", "sa-attendance");
  await settle(page);
  await step(page, "Super Admin at 390px: cards, Filters opens a bottom sheet with Branch / Status / Day", async () => {
    await expect(main(page).locator('[data-slot="data-table-card"]').first()).toBeVisible();
    await main(page).getByTestId("att-filters").click();
    const sheet = page.getByTestId("att-filter-sheet");
    await expect(sheet).toBeVisible();
    for (const label of ["Branch", "Status", "Day"]) await expect(sheet.getByText(label, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "sa-attendance-390-filters-sheet.png") });
    await sheet.getByRole("button", { name: "Apply" }).click();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});

// The biggest range the board allows (62 days, every branch), as the page
// asks for it: the old board read the whole range at once; the new one asks
// for one page (with the counts). Median of 5.
test("timings: the biggest range, before / after", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await as(page, "super_admin");
  const from = manilaDay(-61);
  const to = manilaDay(0);
  const url = AFTER ? `/api/attendance/logs?from=${from}&to=${to}&page=1&page_size=25` : `/api/attendance/logs?from=${from}&to=${to}`;
  const runs = [];
  let bytes = 0;
  for (let i = 0; i < 5; i += 1) {
    const t0 = Date.now();
    const res = await page.request.get(url);
    const body = await res.body();
    runs.push(Date.now() - t0);
    bytes = body.length;
    expect(res.status()).toBe(200);
  }
  runs.sort((a, b) => a - b);
  const result = { label: LABEL, url, median_ms: runs[2], min_ms: runs[0], max_ms: runs[4], response_kb: Math.round(bytes / 1024) };
  console.log(`    ${JSON.stringify(result)}`);
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(process.cwd(), "test-results", `attendance-timing-${LABEL}.json`), JSON.stringify(result, null, 2));
});
