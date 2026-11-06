// Holidays and holiday duty (20261102010000), against the real local stack.
// The school is closed on a holiday: 0 required hours and never absent, unless
// HR assigns the employee to report. Only HR assigns (UI and server); the
// Accountant and the Employee can only see. Expectations come from the rules.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api } from "../support/flow.mjs";
import { profileByEmail } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";
import { TIME_TRAVEL, shiftBrowser, travelHome, travelTo } from "../support/time-travel.mjs";

// Written on November 2, 2026: HR's Holidays & Duty opens on the next
// holiday, so after Nov 2 the duty would land on Nov 30. On a later real date
// the server's "today" is moved back to Nov 2 (E2E_TIME_TRAVEL=1) and home
// again afterwards (full system check 2026-11-05).
const AS_OF = "2026-11-02";
const needsTravel = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }) > AS_OF;
test.afterAll(async () => { if (TIME_TRAVEL) await travelHome(); });

const NOV2 = "2026-11-02"; // All Souls' Day, special non-working (Proclamation No. 1006, s. 2025), a Monday
const NOV1 = "2026-11-01"; // All Saints' Day, a Sunday
const timesheet = (email) => `/api/employee/timesheet?email=${encodeURIComponent(email)}&start_date=2026-10-26&end_date=2026-11-09`;
const day = (records, key) => records.find((r) => r.date === key);

test("holidays: badges, 0 required hours, and HR-only holiday duty", async ({ page }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  test.skip(needsTravel() && !TIME_TRAVEL, `date-dependent: run with E2E_TIME_TRAVEL=1 (it moves the server to ${AS_OF})`);
  if (needsTravel()) {
    await shiftBrowser(page.context());
    // On the app's origin, so the browser's date moves too (localStorage).
    await page.goto("/api/health");
    await travelTo(AS_OF, page);
  }

  await as(page, "employee", "emp-timesheet");
  await step(page, "Employee > Timesheet Oct 26 - Nov 9: Nov 1 and Nov 2 show their holidays, 0 hours, no absence", async () => {
    const res = await api(page, "GET", timesheet(ACCOUNTS.employee.email));
    expect(res.status).toBe(200);
    const nov1 = day(res.data.records, NOV1);
    const nov2 = day(res.data.records, NOV2);
    expect(nov1).toMatchObject({ rest_day: true, required_hours: 0 });
    expect(nov1.holiday?.label).toMatch(/^Special non-working day: All Saints/);
    expect(nov2).toMatchObject({ rest_day: false, required_hours: 0, duty: null });
    expect(nov2.holiday?.label).toBe("Special non-working day: All Souls' Day");
    expect(nov2.status).not.toBe("Absent");
    // An ordinary day next to them still asks for the full shift.
    expect(day(res.data.records, "2026-11-03").required_hours).toBeGreaterThan(0);
    // The UI: generate the default range (this month to today) and see both badges on Nov 1.
    await main(page).getByRole("button", { name: /Generate/ }).click();
    await settle(page);
    const row = main(page).getByRole("row", { name: new RegExp(NOV1) });
    await expect(row.getByText("Rest day", { exact: true })).toBeVisible();
    await expect(row.getByText(/Special non-working day: All Saints/)).toBeVisible();
  });

  await step(page, "Employee > cannot assign holiday duty (direct API call)", async () => {
    const res = await api(page, "POST", "/api/holiday-duty", { action: "assign", holiday_date: NOV2, employee_ids: [ana.id] });
    expect(res.status).toBe(403);
  });

  await as(page, "accountant", "ac-holidays");
  await step(page, "Accountant > Holidays & Duty: read-only, and the server refuses changes", async () => {
    await settle(page);
    await expect(main(page).getByText("Holidays & Duty").first()).toBeVisible();
    await expect(main(page).getByText("Require staff to report")).toHaveCount(0);
    expect((await api(page, "POST", "/api/holiday-duty", { action: "assign", holiday_date: NOV2, employee_ids: [ana.id] })).status).toBe(403);
    expect((await api(page, "DELETE", "/api/holiday-duty?id=00000000-0000-0000-0000-000000000000")).status).toBe(403);
    expect((await api(page, "GET", `/api/holiday-duty?date=${NOV2}`)).status).toBe(200);
  });

  await as(page, "hr", "hr-holidays");
  let assignmentId = null;
  await step(page, "HR > Holidays & Duty > Nov 2: assign Ana (guard duty) in the UI", async () => {
    await settle(page);
    const open = main(page).getByRole("button", { name: /All Souls/ });
    if (await open.isVisible().catch(() => false)) await open.click();
    await settle(page);
    await expect(main(page).getByText("Require staff to report")).toBeVisible();
    await main(page).locator("#duty-search").fill("Ana");
    // Ana Lopez herself, not whoever else the search finds first.
    await main(page).getByRole("group", { name: "Employees" }).getByRole("checkbox", { name: /^Ana.*Lopez/ }).first().check();
    await main(page).locator("#duty-note").fill("Guard duty");
    await main(page).getByRole("button", { name: "Assign", exact: true }).click();
    await settle(page);
    await expect(main(page).getByRole("row", { name: /Ana/ }).getByText("Guard duty")).toBeVisible();
    const res = await api(page, "GET", `/api/holiday-duty?date=${NOV2}`);
    const row = res.data.assigned.find((a) => a.employee_id === ana.id);
    expect(row).toMatchObject({ note: "Guard duty", required_hours: 8 });
    expect(row.assigned_by_name).toBeTruthy();
    expect(res.data.history.some((h) => h.action === "assigned" && h.employee_name)).toBe(true);
    assignmentId = row.id;
  });

  await step(page, "HR > a special working day (Feb 25) cannot take holiday duty", async () => {
    const res = await api(page, "POST", "/api/holiday-duty", { action: "assign", holiday_date: "2026-02-25", employee_ids: [bea.id] });
    expect(res.status).toBe(400);
  });

  await as(page, "employee", "emp-dash");
  await step(page, "Employee (Ana) > Dashboard and Timesheet show the duty; Nov 2 now asks 8 hours", async () => {
    await settle(page);
    await expect(main(page).getByText("Holiday duty").first()).toBeVisible();
    const res = await api(page, "GET", timesheet(ACCOUNTS.employee.email));
    expect(day(res.data.records, NOV2)).toMatchObject({ row_type: "duty", required_hours: 8 });
    expect(day(res.data.records, NOV2).duty.note).toBe("Guard duty");
  });

  await as(page, "hr", "hr-holidays");
  await step(page, "HR > remove the duty again (logged)", async () => {
    const res = await api(page, "DELETE", `/api/holiday-duty?id=${assignmentId}`);
    expect(res.status).toBe(200);
    const after = await api(page, "GET", `/api/holiday-duty?date=${NOV2}`);
    expect(after.data.assigned.some((a) => a.employee_id === ana.id)).toBe(false);
    expect(after.data.history.some((h) => h.action === "removed")).toBe(true);
  });
});
