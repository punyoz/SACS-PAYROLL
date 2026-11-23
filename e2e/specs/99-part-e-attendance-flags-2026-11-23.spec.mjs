// Part E step 2 (2026-11-23): attendance flags. The nightly run flags a missing
// tap; the employee is told and sees it under "The system found these to fix";
// Request correction opens filled in; once filed, the next run closes the flag.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { choose, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const setPaused = (value) => db().from("system_config").update({ value }).eq("section", "automation").eq("key", "paused");

test("attendance flags: a missing tap is flagged, shown to the employee, fixed by a filled-in correction, closed", async ({ page, monitor }) => {
  monitor.at("Employee > My Attendance (to fix)");
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  // Yesterday, or the last weekday before it.
  let day = manilaDay(-1);
  for (let n = 1; [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()); n += 1) day = manilaDay(-1 - n);
  psql(`set session_replication_role = replica; delete from attendance_logs where employee_id = '${bea.id}' and log_date = '${day}';`);
  const [log] = await rows(db().from("attendance_logs").insert({
    employee_id: bea.id, employee_name: bea.full_name, branch_id: bea.branch_id, log_date: day,
    time_in: `${day}T08:00:00+08:00`, status: "Incomplete", shift_end_minutes: 1020,
  }).select("id"));
  // Colleagues tapped that day, so it is not a device / data-problem branch-day (where nobody is flagged).
  psql(`set session_replication_role = replica; update attendance_logs set time_in = '${day}T07:50:00+08:00', time_out = '${day}T17:00:00+08:00', status = 'On Time'
        where branch_id = '${bea.branch_id}' and log_date = '${day}' and employee_id <> '${bea.id}' and time_in is null and time_out is null;`);
  await setPaused("false");
  try {
    await step(page, "The nightly run flags Bea's missing time-out and tells her", async () => {
      const { data, error } = await db().rpc("automation_attendance_flags", { p_day: day });
      expect(error).toBeNull();
      expect(data.flagged).toBeGreaterThan(0);
      const [flag] = await rows(db().from("automation_actions").select("status,data").eq("entity_id", log.id));
      expect(flag).toMatchObject({ status: "open", data: expect.objectContaining({ code: "missing_tap" }) });
      expect((await rows(db().from("notifications").select("link_page").eq("recipient_id", bea.id).eq("kind", "attendance_fix"))).length).toBeGreaterThan(0);
    });

    await step(page, "Admin > Branch Attendance: the system's flag and its status; no manual Flag issue; a Note sends it to HR", async () => {
      await as(page, "admin", `adm-attendance&adm_att_from=${day}&adm_att_to=${day}`);
      await settle(page);
      await expect(main(page).getByRole("button", { name: /Flag issue/ })).toHaveCount(0);
      const row = main(page).getByRole("row").filter({ hasText: bea.full_name });
      await expect(row.getByTestId("system-flag")).toContainText("Flagged by the system");
      // Manual attendance flags are refused by the server (2026-11-24); incidents stay manual.
      const manual = await page.request.post("/api/admin/branch-oversight", { data: { action: "file", kind: "attendance_flag", ref_id: log.id, note: "E2E manual flag" } });
      expect(manual.status()).toBe(409);
      await row.getByRole("button", { name: "Note" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("textarea").first().fill("E2E: she says the reader was busy at 5 pm");
      await dialog.getByRole("button", { name: "Send note to HR" }).click();
      await expect(dialog).toBeHidden({ timeout: 20000 });
      const [flag] = await rows(db().from("automation_actions").select("status,admin_note").eq("entity_id", log.id));
      expect(flag).toMatchObject({ status: "with_hr", admin_note: expect.stringMatching(/reader was busy/) });
      await expect(row.getByTestId("system-flag")).toContainText("With HR");
    });

    await step(page, "Employee > My Attendance > The system found these to fix > Request correction (filled in)", async () => {
      await as(page, "employee2", "emp-attendance");
      await settle(page);
      const item = main(page).getByTestId("attendance-fix").filter({ hasText: "no time-out" });
      await expect(item).toBeVisible();
      await item.getByRole("button", { name: "Request correction" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Attendance correction request")).toBeVisible();
      // Filled in from the flag: "Missing time out" (the day has a time in).
      await expect(dialog.locator("#corr-fix")).toContainText("Missing time out");
      await dialog.locator("#corr-out").fill("17:00");
      await choose(page, dialog.locator("#corr-reason"), "Forgot to tap out");
      await dialog.locator("#corr-note").fill("Forgot to tap out at 5 pm");
      await dialog.getByRole("button", { name: "Send request" }).click();
      await expect(dialog).toBeHidden({ timeout: 20000 });
      expect((await rows(db().from("attendance_corrections").select("status").eq("log_id", log.id))).map((c) => c.status)).toContain("pending");
    });

    await step(page, "The next run closes the flag; the list no longer shows it", async () => {
      await db().rpc("automation_attendance_flags", { p_day: day });
      expect((await rows(db().from("automation_actions").select("status").eq("entity_id", log.id).single())).status).toBe("closed");
      await page.reload();
      await settle(page);
      await expect(main(page).getByTestId("attendance-fix").filter({ hasText: "no time-out" })).toHaveCount(0);
    });
  } finally {
    await setPaused("false"); // the default: automation on (user decision 2026-11-23)
  }
});
