// Part E step 3 (2026-11-23), as changed since 8f4d052: HR changes schedules;
// the Admin's Schedules page is view only and a new schedule request is
// refused. A request filed before that change (pending) still works: HR
// approves (manual) and the system applies it from the start date, logged
// "by System"; HR can Undo it (a version restoring the previous schedule).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const setPaused = (value) => db().from("system_config").update({ value }).eq("section", "automation").eq("key", "paused");

test("schedule request: Admin view only (a new request refused); an earlier pending request: HR approves; applied from the date; HR undoes it", async ({ page, monitor }) => {
  monitor.allow(/^409 POST \/api\/admin\/branch-oversight/, /status of 409/);
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
  await step(page, "Admin > Schedules: view only; a new schedule request is refused", async () => {
    await as(page, "admin", "adm-schedules");
    await settle(page);
    await expect(main(page).getByText(/HR changes work schedules and class loads/)).toBeVisible();
    await expect(main(page).getByRole("button", { name: "Request a change" })).toHaveCount(0);
    const refused = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "schedule_request", employee_id: ana.id, details: { request_type: "schedule", schedule_key: scheduleKey, effective_from: start, requested: "" }, note: `${TAG} please` });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/You file incident reports, incentive proposals and RFID issues only/);
    expect(await rows(db().from("branch_admin_requests").select("id").eq("admin_note", `${TAG} please`))).toHaveLength(0);
    // A request the Admin filed before the change, still pending.
    const admin = await profileByEmail(ACCOUNTS.admin.email);
    const [sched] = await rows(db().from("work_schedules").select("name").eq("schedule_key", scheduleKey).limit(1));
    const [made] = await rows(db().from("branch_admin_requests").insert({
      branch_id: ana.branch_id, kind: "schedule_request", employee_id: ana.id, status: "pending", admin_note: `${TAG} earlier`,
      details: { employee_name: ana.full_name, request_type: "schedule", request_type_label: "Work schedule", effective_from: start, requested: "", schedule_key: scheduleKey, schedule_name: sched.name },
      created_by: admin.id, created_by_name: admin.full_name, history: [],
    }).select("id"));
    requestId = made.id;
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

    await step(page, "HR > Automation > Undo (preset): a version restores the previous schedule from that date", async () => {
      await as(page, "hr", "hr-automation");
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
