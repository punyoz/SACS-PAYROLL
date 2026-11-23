// No self-approval with TWO active HR officers (2026-11-23): another HR who
// covers the requester's branch decides; the requester never sees Approve on
// their own request; an HR with no home branch covers every branch; no other HR
// at all -> the Super Admin. Also (Part E step 4): the branch Admin cannot
// endorse their own request, and "no action -> to HR after one working day"
// happens once.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const lastWeekday = () => {
  for (let n = 1; n < 10; n += 1) {
    const d = manilaDay(-n);
    if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) return d;
  }
  return manilaDay(-1);
};

test("two HR officers: the other one decides; never Approve on your own; branch coverage; the Super Admin only when no other HR", async ({ page, monitor }) => {
  monitor.allow(/^403 (PATCH|POST) \/api\//, /status of 403/);
  const hector = await profileByEmail(ACCOUNTS.hr.email);
  const hana = await profileByEmail(ACCOUNTS.hr2.email);
  const branches = await rows(db().from("branches").select("id,name").order("name"));
  const [main1, north] = [branches.find((b) => b.name.includes("Main")) || branches[0], branches.find((b) => !b.name.includes("Main")) || branches[1]];
  const restore = { hector: hector.branch_id };
  await db().from("profiles").update({ archived: false, branch_id: null }).eq("id", hana.id);
  await db().from("profiles").update({ branch_id: null }).eq("id", hector.id);
  try {
    const day = lastWeekday();
    psql(`set session_replication_role = replica; delete from attendance_corrections where employee_id = '${hector.id}' and log_date = '${day}'; delete from attendance_logs where employee_id = '${hector.id}' and log_date = '${day}';`);
    const [log] = await rows(db().from("attendance_logs").insert({ employee_id: hector.id, employee_name: hector.full_name, branch_id: main1.id, log_date: day, status: "Absent" }).select("id"));
    let requestId;

    await step(page, "Hector files his own correction: it waits for Hana (another HR), not the Super Admin", async () => {
      await as(page, "hr", "hr-my-leave");
      const filed = await api(page, "POST", "/api/attendance/corrections", { log_id: log.id, fix_type: "missing_in", time_in: "08:00", time_out: "17:00", reason_code: "forgot_in" });
      expect(filed.status, JSON.stringify(filed.data)).toBe(200);
      requestId = filed.data.correction.id;
      const who = await api(page, "GET", "/api/me/approver");
      expect(who.data).toMatchObject({ kind: "hr", label: expect.stringContaining("Hana Second") });
    });

    await step(page, "Hector's own row: no Review / Approve, no checkbox; the server refuses too", async () => {
      await as(page, "hr", "hr-leaves");
      await settle(page);
      const card = main(page).getByTestId("hr-correction-requests");
      const own = card.getByRole("row").filter({ hasText: day });
      await expect(own.getByTestId("own-request")).toBeVisible();
      await expect(own.getByRole("button", { name: /Review|Approve/ })).toHaveCount(0);
      await expect(own.getByRole("checkbox")).toHaveCount(0);
      expect((await api(page, "PATCH", "/api/attendance/corrections", { correction_id: requestId, decision: "approve", remark: { code: "approve.as_requested" } })).status).toBe(403);
    });

    await step(page, "Not on the Super Admin's fallback list (an HR covers it)", async () => {
      await as(page, "super_admin", "sa-fallback");
      const list = await api(page, "GET", "/api/super-admin/fallback");
      expect(list.data.items.some((i) => i.id === requestId)).toBe(false);
    });

    await step(page, "Hana (the other HR) approves it", async () => {
      await as(page, "hr2", "hr-leaves");
      await settle(page);
      const card = main(page).getByTestId("hr-correction-requests");
      await expect(card.getByRole("row").filter({ hasText: day }).getByRole("button", { name: "Review" })).toBeVisible();
      const res = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: requestId, decision: "approve", remark: { code: "approve.as_requested" } });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect((await rows(db().from("attendance_corrections").select("status,approved_by_name").eq("id", requestId).single())).status).toBe("approved");
    });

    await step(page, "Coverage: Hana with home branch North; Hector with no home branch covers it; Hector at Main does not", async () => {
      await db().from("profiles").update({ branch_id: north.id }).eq("id", hana.id);
      await as(page, "hr2", "hr-my-leave");
      expect((await api(page, "GET", "/api/me/approver")).data).toMatchObject({ kind: "hr", label: expect.stringContaining("Hector") });
      await db().from("profiles").update({ branch_id: main1.id }).eq("id", hector.id);
      expect((await api(page, "GET", "/api/me/approver")).data, "Hector covers only Main now").toMatchObject({ kind: "super_admin" });
    });

    await step(page, "No other HR at all: the Super Admin decides", async () => {
      await db().from("profiles").update({ archived: true }).eq("id", hana.id);
      await db().from("profiles").update({ branch_id: null }).eq("id", hector.id);
      await as(page, "hr", "hr-my-leave");
      expect((await api(page, "GET", "/api/me/approver")).data).toMatchObject({ kind: "super_admin" });
    });
  } finally {
    await db().from("profiles").update({ archived: true, branch_id: null }).eq("id", hana.id);
    await db().from("profiles").update({ branch_id: restore.hector }).eq("id", hector.id);
  }
});

test("leave recommendation: the Admin cannot endorse their own request; 'to HR after one working day' happens once", async ({ page, monitor }) => {
  monitor.allow(/^403 POST \/api\/admin\/branch-oversight/, /status of 403/);
  const admin = await profileByEmail(ACCOUNTS.admin.email);
  const day = manilaDay(25);
  const [own] = await rows(db().from("leave_requests").insert({ id: `e2e-own-${Date.now()}`, employee_id: admin.id, employee_name: admin.full_name, branch_id: admin.branch_id,
    leave_type: "Vacation Leave", pay_status: "with_pay", start_date: day, end_date: day, reason: "E2E own", status: "pending_admin" }).select("id"));
  await step(page, "Admin > endorsing their own leave is refused", async () => {
    await as(page, "admin", "adm-leaves");
    const res = await api(page, "POST", "/api/admin/branch-oversight", { action: "file", kind: "leave_endorsement", ref_id: own.id, decision: "endorse", remark: { code: "endorse.recommend" } });
    expect(res.status).toBe(403);
  });
  await step(page, "No action by the due date: forwarded to HR once, however often the daily run goes", async () => {
    await db().from("system_config").update({ value: "false" }).eq("section", "automation").eq("key", "paused");
    const ana = await profileByEmail(ACCOUNTS.employee.email);
    const { data: id } = await db().rpc("automation_log", { p_module: "leave_recommendations", p_rule: "E2E forward once", p_kind: "proposal", p_summary: `E2E forward once ${Date.now()}`,
      p_data: {}, p_employee: ana.id, p_branch: ana.branch_id, p_entity_type: "leave_request", p_entity_id: `e2e-fwd-${Date.now()}` });
    await db().from("automation_actions").update({ admin_due_on: manilaDay(-1) }).eq("id", id);
    const before = (await rows(db().from("notifications").select("id").eq("kind", "automation_forwarded"))).length;
    await db().rpc("automation_daily", {});
    const first = await rows(db().from("automation_actions").select("status,forwarded_at,forwarded_by").eq("id", id).single());
    expect(first).toMatchObject({ status: "with_hr", forwarded_by: "System" });
    const afterOne = (await rows(db().from("notifications").select("id").eq("kind", "automation_forwarded"))).length;
    await db().rpc("automation_daily", {});
    await db().rpc("automation_daily", {});
    const again = await rows(db().from("automation_actions").select("forwarded_at").eq("id", id).single());
    expect(again.forwarded_at, "forwarded once: the time does not move").toBe(first.forwarded_at);
    expect((await rows(db().from("notifications").select("id").eq("kind", "automation_forwarded"))).length, "HR told once").toBe(afterOne);
    expect(afterOne).toBeGreaterThan(before);
  });
});
