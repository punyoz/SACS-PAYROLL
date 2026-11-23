// Part E step 3 (2026-11-23): the Admin's schedule request names one of HR's
// schedules; HR approves (manual) and the system applies it from the start
// date, logged "by System"; HR can Undo it (a version restoring the previous
// schedule). While paused, approving applies nothing.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const setPaused = (value) => db().from("system_config").update({ value }).eq("section", "automation").eq("key", "paused");

test("schedule request: Admin picks an HR schedule; HR approves; applied from the date; HR undoes it", async ({ page, monitor }) => {
  monitor.allow(/^400 POST \/api\/admin\/branch-oversight/, /status of 400/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const start = manilaDay(7);
  const TAG = `E2E sched ${Date.now()}`;
  let scheduleKey;

  await step(page, "HR creates a work schedule to pick", async () => {
    await as(page, "hr", "hr-schedules");
    const made = await api(page, "POST", "/api/admin/work-schedules", { action: "save_schedule", name: `${TAG} 7-4`, work_start: "07:00", work_end: "16:00", grace_minutes: 10, work_hours: 8, working_days: [1, 2, 3, 4, 5], effective_from: manilaDay(0) });
    expect([200, 201], JSON.stringify(made.data)).toContain(made.status);
    scheduleKey = (await rows(db().from("work_schedules").select("schedule_key").eq("name", `${TAG} 7-4`).limit(1)))[0].schedule_key;
  });

  let requestId;
  await step(page, "Admin > Schedule requests > the form offers HR's schedules; a request with no pick is refused", async () => {
    await as(page, "admin", "adm-schedules");
    await settle(page);
    await main(page).getByRole("button", { name: "Request a change" }).click();
    const dialog = page.getByRole("dialog");
    await choose(page, dialog.locator("#ov-schedule_key"), `${TAG} 7-4`);
    await page.keyboard.press("Escape");
    const fileReq = (details, note) => api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "schedule_request", employee_id: ana.id, details, note });
    const none = await fileReq({ request_type: "schedule", effective_from: start, requested: "" }, `${TAG} no pick`);
    expect(none.status).toBe(400);
    const filed = await fileReq({ request_type: "schedule", schedule_key: scheduleKey, effective_from: start, requested: "" }, `${TAG} please`);
    expect([200, 201], JSON.stringify(filed.data)).toContain(filed.status);
    requestId = (await rows(db().from("branch_admin_requests").select("id,details").eq("kind", "schedule_request").eq("admin_note", `${TAG} please`)))[0].id;
    const twin = await fileReq({ request_type: "schedule", schedule_key: scheduleKey, effective_from: start, requested: "" }, `${TAG} again`);
    expect(twin.status, "a duplicate for the same employee and date").toBe(400);
  });

  await setPaused("false");
  try {
    await step(page, "HR approves: the system applies it from the start date and logs it", async () => {
      await as(page, "hr", "hr-branch-requests");
      const res = await api(page, "PATCH", "/api/hr/branch-requests", { id: requestId, decision: "approve", remark: { code: "approve.as_requested" } });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      const versions = await rows(db().from("work_schedule_assignments").select("schedule_key,effective_from,created_by_name").eq("employee_id", ana.id).eq("effective_from", start));
      expect(versions).toEqual([expect.objectContaining({ schedule_key: scheduleKey, created_by_name: "System" })]);
      const [action] = await rows(db().from("automation_actions").select("id,status,kind").eq("module", "schedule_requests").eq("data->>request_id", requestId));
      expect(action).toMatchObject({ status: "done", kind: "applied" });
    });

    await step(page, "HR > Dashboard > Automation > Undo (preset): a version restores the previous schedule from that date", async () => {
      await as(page, "hr", "hr-dashboard");
      await settle(page);
      const [action] = await rows(db().from("automation_actions").select("id").eq("module", "schedule_requests").eq("data->>request_id", requestId));
      const undone = await api(page, "PATCH", "/api/automation", { id: action.id, action: "undo", remark: { code: "revoke.automation.in_error" } });
      expect(undone.status, JSON.stringify(undone.data)).toBe(200);
      const versions = await rows(db().from("work_schedule_assignments").select("schedule_key,created_at").eq("employee_id", ana.id).eq("effective_from", start).order("created_at", { ascending: false }));
      expect(versions).toHaveLength(2);
      expect(versions[0].schedule_key, "the newest version puts back what Ana had (her default)").toBeNull();
      expect((await rows(db().from("automation_actions").select("status,undo_reason").eq("id", action.id).single()))).toMatchObject({ status: "undone", undo_reason: "Applied in error" });
    });
  } finally {
    await setPaused("false"); // the default: automation on (user decision 2026-11-23)
  }
});
