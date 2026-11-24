// Leave & Overtime (2026-11-22, was "My Leave") for the Employee, HR and the
// Accountant: the sidebar label, balances at the top, one New request button
// with the type chosen, Leave / Half day / Overtime tabs with pending counts,
// and the old address opening the right tab. Screenshots for the review go to
// docs/reports/leave-overtime/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay, newRequest, requestTab } from "../support/flow.mjs";
import { db, profileByEmail } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const OUT = join(process.cwd(), "docs", "reports", "leave-overtime");
mkdirSync(OUT, { recursive: true });

const weekday = (n) => {
  for (let d = n; d < n + 10; d += 1) {
    const day = manilaDay(d);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return day;
  }
  return manilaDay(n);
};

for (const [role, pageId] of [["employee", "emp-leave"], ["hr", "hr-my-leave"], ["accountant", "ac-my-leave"]]) {
  test(`${role}: Leave & Overtime — label, balances, one New request, three tabs`, async ({ page, monitor }) => {
    monitor.at(`${role} > Leave & Overtime`);
    await as(page, role, pageId);
    await settle(page);

    // Part I (2026-11-23): "Leave & Overtime" is "My Requests" (its page title, and a tab or item in the sidebar).
    await step(page, `${role} > the page is "My Requests" (no "My Leave")`, async () => {
      const nav = page.locator("nav, aside").first();
      await expect(page.locator("header h1")).toHaveText("My Requests");
      await expect(page.getByRole("link", { name: /^My Requests/ }).first()).toBeVisible();
      await expect(page.getByText("My Leave", { exact: true })).toHaveCount(0);
      await nav.screenshot({ path: join(OUT, `${role}-sidebar.png`) }).catch(() => page.screenshot({ path: join(OUT, `${role}-sidebar.png`) }));
    });

    await step(page, `${role} > balances on top, then the requests with Leave / Half day / Overtime tabs`, async () => {
      // The leave-credits pool (PR #55): one total for vacation, sick and emergency leave.
      await expect(main(page).getByTestId("leave-credits")).toBeVisible();
      await expect(main(page).getByText("Leave credits", { exact: true }).first()).toBeVisible();
      for (const t of ["Leave", "Half day", "Overtime"]) await expect(main(page).getByRole("tab", { name: new RegExp(`^${t}`) })).toBeVisible();
      await expect(main(page).getByRole("tab", { name: /^Leave/ })).toHaveAttribute("aria-selected", "true");
      await expect(main(page).getByTestId("new-request")).toHaveCount(1);
      await page.screenshot({ path: join(OUT, `${role}-page.png`), fullPage: true });
    });

    await step(page, `${role} > New request: the type picks the form (Leave, Half day, Overtime)`, async () => {
      const leaveForm = await newRequest(page, "leave");
      await expect(leaveForm.getByLabel("End date")).toBeVisible();
      await expect(leaveForm.getByRole("combobox", { name: "Length" })).toHaveCount(0);
      await page.screenshot({ path: join(OUT, `${role}-new-request-leave.png`) });
      await page.keyboard.press("Escape");
      const halfForm = await newRequest(page, "half");
      await expect(halfForm.getByRole("combobox", { name: "Length" })).toBeVisible();
      await expect(halfForm.getByLabel("End date")).toHaveCount(0);
      await page.keyboard.press("Escape");
      const otForm = await newRequest(page, "overtime");
      await expect(otForm.getByRole("button", { name: "File overtime request" })).toBeVisible();
      await page.screenshot({ path: join(OUT, `${role}-new-request-overtime.png`) });
      await page.keyboard.press("Escape");
    });
  });
}

// Dates show as "Nov 26, 2026" (2026-11-24 release).
const shownDate = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

test("employee: the tab is in the address; a pending overtime shows its count on the tab", async ({ page, monitor }) => {
  monitor.at("Employee > Leave & Overtime (tabs)");
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const day = weekday(4);
  await db().from("overtime_requests").delete().eq("employee_id", bea.id).eq("request_date", day);
  await as(page, "employee2", "emp-leave");
  const filed = await api(page, "POST", "/api/me/overtime-requests", { request_date: day, planned_start: "17:00", planned_end: "18:00", reason: "E2E Leave & Overtime tab count" });
  expect(filed.status, JSON.stringify(filed.data)).toBe(201);
  try {
    await page.goto("/employee?page=emp-leave&lo_tab=overtime");
    await settle(page);
    await expect(main(page).getByRole("tab", { name: /^Overtime/ })).toHaveAttribute("aria-selected", "true");
    await expect(main(page).getByRole("tab", { name: /^Overtime\s*[1-9]/ })).toBeVisible();
    await expect(main(page).getByTestId("my-overtime-requests").getByRole("row").filter({ hasText: shownDate(day) })).toContainText("Pending");
    await page.screenshot({ path: join(OUT, "employee-overtime-tab.png"), fullPage: true });
    // Back to Leave, then the old address (no tab) opens Leave.
    await requestTab(page, "Leave");
    await page.goto("/employee?page=emp-leave");
    await settle(page);
    await expect(main(page).getByRole("tab", { name: /^Leave/ })).toHaveAttribute("aria-selected", "true");
  } finally {
    await db().from("overtime_requests").delete().eq("id", filed.data?.request?.id || "00000000-0000-0000-0000-000000000000");
  }
});
