// Part B (2026-11-22): a half-day leave. The Employee files the afternoon of
// one day; HR sees "(PM)" and half a day, approves; the day is not a full
// leave day (the kiosk still accepts taps for the morning) and the balance
// uses 0.5 day. The attendance and payroll rules themselves are checked in
// scripts/checks/half-day-leave-scenarios.sql and the unit tests.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm, manilaDay, pickDate, refresh, newRequest, requestTab } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const REASON = `E2E half day ${Date.now()}`;

/** The next weekday at least `from` days ahead (a working day for the default schedule). */
function nextWeekday(from) {
  for (let n = from; n < from + 7; n += 1) {
    const key = manilaDay(n);
    if (![0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay())) return key;
  }
  throw new Error("no weekday");
}

test("half-day leave: the employee files the afternoon, HR approves half a day, the morning keeps its taps", async ({ page, monitor }) => {
  const day = nextWeekday(2);
  const emp = await profileByEmail(ACCOUNTS.employee.email);
  let saved;

  await step(page, "Employee > Leave > Length: Half day (PM) shows one date and the requests' window", async () => {
    monitor.at("Employee > Leave");
    await as(page, "employee", "emp-leave");
    const form = await newRequest(page, "half");
    await choose(page, form.getByRole("combobox", { name: "Length" }), "Half day: afternoon (PM)");
    await expect(form.getByLabel("End date"), "a half day has one date").toHaveCount(0);
    await expect(form.getByText(/At least 1 day before, or up to 2 days after as a late filing\./)).toBeVisible();
    await expect(form.getByText(/Counts as half a day of leave credit/)).toBeVisible();
  });

  await step(page, "Employee > Leave > file Sick Leave for the afternoon", async () => {
    const form = page.getByRole("dialog", { name: "New request" }).locator("form").first();
    await choose(page, form.getByRole("combobox").first(), "Sick Leave");
    await pickDate(page, form.getByLabel("Date", { exact: true }), day);
    await form.getByPlaceholder("State the reason for your leave request").fill(REASON);
    await form.getByRole("button", { name: /Submit/ }).click();
    await settle(page);
    saved = await rows(db().from("leave_requests").select("id,status,start_date,end_date,half_day").eq("employee_id", emp.id).eq("reason", REASON).single());
    expect(saved).toMatchObject({ start_date: day, end_date: day, half_day: "PM" });
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: REASON }).getByText(`${day}, Half day: afternoon (PM)`)).toBeVisible();
  });

  await step(page, "Server > a half day across two days or a bad half is refused", async () => {
    const bad = await api(page, "POST", "/api/me/leave-requests", { leave_type: "Sick Leave", pay_status: "with_pay", start_date: day, end_date: day, half_day: "noon", reason: "E2E bad half" });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe("Choose the morning (AM) or the afternoon (PM).");
  });

  await step(page, "HR > Leave Approval > the request reads (PM) and 0.5 days; approve", async () => {
    monitor.at("HR > Leave Approval");
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).locator("li", { hasText: REASON });
    await expect(card).toContainText("0.5 days");
    await expect(card).toContainText(`${day} (PM)`);
    await card.getByRole("button", { name: "Approve" }).click();
    await confirm(page, "Approve");
    const after = await rows(db().from("leave_requests").select("status").eq("id", saved.id).single());
    expect(after.status).toBe("approved");
  });

  await step(page, "Attendance > the day is not a full leave day: no On Leave row, the kiosk's leave check is empty", async () => {
    const logs = await rows(db().from("attendance_logs").select("status").eq("employee_id", emp.id).eq("log_date", day).eq("archived_duplicate", false));
    expect(logs.filter((l) => l.status === "On Leave")).toEqual([]);
    const { data, error } = await db().rpc("attendance_approved_leave", { p_employee_id: emp.id, p_day: day });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  await step(page, "Employee > Leave > Approved; the balance used counts half a day", async () => {
    monitor.at("Employee > Leave (after decision)");
    await as(page, "employee", "emp-leave");
    await requestTab(page, "Half day");
    await expect(main(page).locator("tr", { hasText: REASON }).getByText("Approved")).toBeVisible();
    const res = await api(page, "GET", "/api/me/leave-requests");
    expect(res.status).toBe(200);
    const used = res.data.balance?.by_type?.["Sick Leave"]?.used;
    expect(used % 1, `Sick Leave used ${used}: includes the half day`).toBe(0.5);
  });
});
