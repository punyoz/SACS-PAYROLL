// Summary card numbers equal the rows they open, on a weekday and on a
// weekend (decision 2026-11-14: one "Present" group, "Absent today" = the
// scheduled who have not tapped in). Moves the server's today, so it runs on
// its own, serially:
//
//   E2E_TIME_TRAVEL=1 E2E_HEADLESS=1 E2E_SLOWMO=0 E2E_RESET=0 npx playwright test e2e/specs/99-card-dates.spec.mjs --project=desktop
//
// Also prints the dashboards' numbers before and after the new definitions
// (the old ones worked out from the same day's records).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { ACCOUNTS } from "../accounts.mjs";
import { settle } from "../support/portal.mjs";
import { walkCards, report } from "../support/cards.mjs";
import { TIME_TRAVEL, shiftBrowser, travelHome, travelTo } from "../support/time-travel.mjs";

test.describe.configure({ mode: "serial" });

const OUT = join(process.cwd(), "screenshots", "2026-11-14-sidebar-cards-reset", "dates");
mkdirSync(OUT, { recursive: true });
// The weekday is the coming Monday: the board's read first runs the database's
// attendance_close_days on the REAL clock, which turns an earlier weekday's
// missing taps into Absent records (as the nightly close does), so a moved
// "today" in the past would no longer look like a live today.
const DATES = [["weekday (Mon)", "2026-11-16"], ["weekend (today, Sat)", "2026-11-14"], ["last Saturday", "2026-11-07"]];
const DASHBOARDS = [["hr", "hr-dashboard"], ["admin", "adm-dashboard"], ["employee", "emp-dash"], ["super_admin", "sa-dashboard"], ["accountant", "ac-dashboard"]];
const PRESENT = ["On Time", "Early Bird", "Late", "Undertime", "Half Day", "Corrected"];

const getJson = async (page, path) => {
  const r = await page.request.get(path);
  expect(r.ok(), `${path} answered ${r.status()}`).toBe(true);
  return r.json();
};

test("card numbers equal the opened rows on a weekday and a weekend; numbers before / after", async ({ page, context }) => {
  test.skip(!TIME_TRAVEL, "run with E2E_TIME_TRAVEL=1 (the server's today must move)");
  test.setTimeout(30 * 60 * 1000);
  await shiftBrowser(context);
  const numbers = [];
  // Production closes each past day overnight (pg_cron); the local stack has
  // no cron, so close November now (any board read runs attendance_close_days).
  await as(page, "hr", "hr-dashboard");
  await getJson(page, "/api/attendance/logs?from=2026-11-01&to=2026-11-30");
  try {
    for (const [name, date] of DATES) {
      for (const [role, dash] of DASHBOARDS) {
        await as(page, role, dash);
        await travelTo(date, page);
        await page.goto(`${ACCOUNTS[role].portal}?page=${dash}`);
        await page.locator("#portal-main").waitFor();
        await settle(page);
        expect(await page.evaluate(() => new Date().toISOString().slice(0, 10)), "the browser follows the server's day").toBe(date);
        await walkCards(page, role, dash, { strict: true, label: `[${name} ${date}]` });
        await page.screenshot({ path: join(OUT, `${date}-${role}.png`) });

        if (role === "hr") {
          const hr = await getJson(page, "/api/hr/dashboard");
          const logs = await getJson(page, `/api/attendance/logs?from=${date}&to=${date}`);
          const recorded = (logs.logs || []).filter((l) => !l.not_tapped_yet);
          const byEmployee = new Map(recorded.map((l) => [l.employee_id, l.status]));
          numbers.push({
            date, name, card: "HR Present today",
            before: [...byEmployee.values()].filter((s) => PRESENT.includes(s) && s !== "Late").length,
            after: hr.present_today,
          }, {
            date, name, card: "HR Absent today",
            before: Math.max(0, Number(hr.total_employees) - byEmployee.size),
            after: hr.absent_today,
          });
        }
        if (role === "employee") {
          const me = await getJson(page, "/api/employee/stats");
          numbers.push({ date, name, card: "Employee Present (this month)", before: me.present - me.late, after: me.present });
        }
        if (role === "admin") {
          // One merged "Absent today" card (decision 2026-11-14), same rule as HR's, this branch only.
          await page.goto(`/admin?page=${dash}`);
          await settle(page);
          await expect(page.locator('#portal-main a[data-testid="stat-card-link"]').filter({ hasText: "Absent today" })).toHaveCount(1);
          await expect(page.locator("#portal-main section").getByText("Not tapped in yet", { exact: true })).toHaveCount(0);
          const adm = await getJson(page, "/api/admin/branch-oversight?view=dashboard");
          expect(adm.attendance.absent_today, "the card counts the names listed under it").toBe(adm.not_tapped.length);
          numbers.push({ date, name, card: "Admin Absent today (was: recorded Absent + Not tapped in yet)", before: "-", after: adm.attendance.absent_today });
          numbers.push({ date, name, card: "Admin Present (Late included before and after)", before: adm.attendance.present, after: adm.attendance.present });
        }
      }
    }
  } finally {
    await travelHome(page);
  }
  console.log("\n  BEFORE / AFTER (local seed data)");
  for (const n of numbers) console.log(`  ${n.date} ${n.name.padEnd(22)} ${n.card.padEnd(48)} before ${String(n.before).padStart(3)}  after ${String(n.after).padStart(3)}`);
  writeFileSync(join(OUT, "numbers.json"), JSON.stringify({ numbers, cards: report }, null, 2));
  console.log(`  ${report.length} card links checked, ${report.filter((r) => r.match).length} equal their rows`);
});
