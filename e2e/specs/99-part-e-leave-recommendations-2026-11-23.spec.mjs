// Part E step 4 (2026-11-23): the system fills the branch Admin's leave
// recommendation (credits, filing time, calendar, staffing); the Admin's own
// Endorse sends it on with their word; HR sees it and decides; after the
// approval the system logs what it did and proposes a substitute for a teacher.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const weekdayFrom = (n) => {
  for (let d = n; d < n + 10; d += 1) {
    const key = manilaDay(d);
    if (![0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay())) return key;
  }
  return manilaDay(n);
};

test("leave recommendation: filled by the system, checked by the Admin, decided by HR; substitutes proposed for a teacher", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  await db().from("profiles").update({ employee_type: "Teaching" }).eq("id", ana.id);
  const day = weekdayFrom(20);
  const reason = `E2E leave rec ${Date.now()}`;
  let leaveId;

  await step(page, "Employee files a leave: the system's recommendation is logged for the Admin's check", async () => {
    await as(page, "employee", "emp-leave");
    const filed = await api(page, "POST", "/api/me/leave-requests", { leave_type: "Vacation Leave", pay_status: "with_pay", start_date: day, end_date: day, reason });
    expect(filed.status, JSON.stringify(filed.data)).toBe(201);
    leaveId = filed.data.request.id;
    const [rec] = await rows(db().from("automation_actions").select("status,kind,data").eq("module", "leave_recommendations").eq("entity_type", "leave_request").eq("entity_id", String(leaveId)));
    expect(rec).toMatchObject({ kind: "proposal", status: "admin_check" });
    expect(rec.data.label).toMatch(/^Recommend approval/);
    expect(rec.data.reasons.join(" ")).toMatch(/Credits: .*Filed \d+ days ahead/);
  });

  await step(page, "Admin > Leave recommendations: the system's recommendation is shown; Endorse sends it to HR with the Admin's word", async () => {
    monitor.at("Admin > Leave recommendations");
    await as(page, "admin", "adm-leaves");
    await settle(page);
    await expect(main(page).getByTestId("system-recommendation").first()).toContainText("System: Recommend approval");
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "leave_endorsement", ref_id: leaveId, decision: "endorse", note: "Coverage fine", remark: { code: "endorse.recommend" } });
    expect([200, 201], JSON.stringify(res.data)).toContain(res.status);
    const [rec] = await rows(db().from("automation_actions").select("status,admin_note").eq("module", "leave_recommendations").eq("entity_id", String(leaveId)));
    expect(rec.status).toBe("with_hr");
    expect(rec.admin_note).toMatch(/^Endorsed/);
  });

  await step(page, "HR sees it on the leave request; approves: closed, logged, a substitute proposed to the Admin", async () => {
    monitor.at("HR > Leave Approval");
    await as(page, "hr", "hr-leaves");
    const list = await api(page, "GET", "/api/hr/leave-requests?status=pending");
    const mine = list.data.requests.find((r) => String(r.id) === String(leaveId));
    expect(mine.system_recommendation).toMatchObject({ label: expect.stringMatching(/^Recommend approval/), admin_note: expect.stringMatching(/^Endorsed/) });
    const ok = await api(page, "PATCH", "/api/hr/leave-requests", { id: leaveId, action: "approve", remark: { code: "approve.as_requested" } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const actions = await rows(db().from("automation_actions").select("status,kind,entity_type,summary").eq("module", "leave_recommendations").eq("entity_id", String(leaveId)));
    expect(actions.find((a) => a.entity_type === "leave_request").status).toBe("closed");
    expect(actions.find((a) => a.entity_type === "leave_request_applied")).toMatchObject({ kind: "applied", status: "done" });
    expect(actions.find((a) => a.entity_type === "substitution_proposal")).toMatchObject({ kind: "proposal", status: "admin_check", summary: expect.stringMatching(/^Arrange a substitute for/) });
  });
});
