// No self-approval (2026-11-23). HR files their own attendance correction and
// overtime requests; nobody decides their own; with no other HR covering their
// branch, the Super Admin decides as the stand-in, and the requester sees who it
// waits for. Every other HR decision about themselves is refused server-side:
// tenure grant, AWOL, incentives / loans, transfers, branch requests and
// automation actions.
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

test("HR's own requests go to another HR covering their branch, else the Super Admin; nobody decides their own", async ({ page, monitor }) => {
  monitor.allow(/^403 (PATCH|POST) \/api\/(attendance\/corrections|hr\/|admin\/transfer-requests|automation)/, /status of 403/);
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const others = await rows(db().from("profiles").select("id").eq("role", "hr").eq("archived", false).neq("id", hr.id));
  test.skip(others.length > 0, "this seed has one HR: the stand-in path is what is tested");
  const day = lastWeekday();
  psql(`set session_replication_role = replica; delete from attendance_corrections where employee_id = '${hr.id}' and log_date = '${day}'; delete from attendance_logs where employee_id = '${hr.id}' and log_date = '${day}';`);
  const [log] = await rows(db().from("attendance_logs").insert({ employee_id: hr.id, employee_name: hr.full_name, branch_id: hr.branch_id, log_date: day, status: "Absent" }).select("id"));

  let requestId;
  await step(page, "HR > files their own attendance correction request; it waits for the Super Admin (no other HR)", async () => {
    monitor.at("HR > Leave & Overtime (own request)");
    await as(page, "hr", "hr-my-leave");
    await settle(page);
    const filed = await api(page, "POST", "/api/attendance/corrections", { log_id: log.id, fix_type: "missing_in", time_in: "08:00", time_out: "17:00", reason_code: "forgot_in" });
    expect(filed.status, JSON.stringify(filed.data)).toBe(200);
    requestId = filed.data.correction.id;
    const who = await api(page, "GET", "/api/me/approver");
    expect(who.data).toMatchObject({ kind: "super_admin" });
    await expect(main(page).getByTestId("waiting-for")).toContainText("Super Admin");
  });

  await step(page, "HR cannot decide their own request", async () => {
    const own = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: requestId, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(own.status).toBe(403);
    expect((await rows(db().from("attendance_corrections").select("status").eq("id", requestId).single())).status).toBe("pending");
  });

  await step(page, "HR's own overtime request also waits for the Super Admin", async () => {
    const otDay = manilaDay(3);
    await db().from("overtime_requests").delete().eq("employee_id", hr.id).eq("request_date", otDay);
    const ot = await api(page, "POST", "/api/me/overtime-requests", { request_date: otDay, planned_start: "17:00", planned_end: "18:00", reason: "E2E own overtime" });
    expect([200, 201], JSON.stringify(ot.data)).toContain(ot.status);
    expect((await api(page, "PATCH", "/api/hr/overtime-requests", { id: ot.data.request.id, decision: "approve", remark: { code: "approve.as_requested" } })).status).toBe(403);
  });

  await step(page, "Every other decision about themselves is refused (tenure, AWOL, incentive, transfer, branch request, automation)", async () => {
    expect((await api(page, "POST", "/api/hr/tenure-protection", { action: "grant", employee_id: hr.id, effective_from: manilaDay(0) })).status, "tenure grant").toBe(403);
    expect((await api(page, "POST", "/api/hr/awol-cases", { employee_id: hr.id, first_absent_on: day })).status, "own AWOL case").toBeGreaterThanOrEqual(403);
    const [inc] = await rows(db().from("payroll_monthly_incentives").insert({ employee_id: hr.id, branch_id: hr.branch_id, item_date: manilaDay(0), kind: "incentive", description: "E2E own incentive", amount: 100, approval_status: "pending" }).select("id"));
    expect((await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: "incentive", id: inc.id, decision: "approve", remark: { code: "approve.as_requested" } })).status, "own incentive").toBe(403);
    const branch = (await rows(db().from("branches").select("id").limit(2)));
    const [tr] = await rows(db().from("transfer_requests").insert({ employee_id: hr.id, from_branch_id: branch[0].id, to_branch_id: branch[1].id, status: "pending", remarks: "E2E own transfer" }).select("id"));
    expect((await api(page, "PATCH", "/api/admin/transfer-requests", { id: tr.id, action: "approve", remark: { code: "approve.as_requested" } })).status, "own transfer").toBe(403);
    const [br] = await rows(db().from("branch_admin_requests").insert({ branch_id: branch[0].id, kind: "schedule_request", employee_id: hr.id, details: { request_type: "schedule", effective_from: manilaDay(5), requested: "x" }, admin_note: "E2E own", status: "pending" }).select("id"));
    expect((await api(page, "PATCH", "/api/hr/branch-requests", { id: br.id, decision: "approve", remark: { code: "approve.as_requested" } })).status, "own branch request").toBe(403);
    const { data: actionId } = await db().rpc("automation_log", { p_module: "spec_test", p_rule: "an E2E rule", p_kind: "applied", p_summary: "E2E about HR", p_data: {}, p_employee: hr.id, p_branch: null });
    expect((await api(page, "PATCH", "/api/automation", { id: actionId, action: "undo", remark: { code: "revoke.automation.in_error" } })).status, "own automation action").toBe(403);
    await db().from("transfer_requests").delete().eq("id", tr.id);
  });

  await step(page, "Super Admin > Fallback approvals: both own requests are there; approving the correction applies it", async () => {
    monitor.at("Super Admin > Fallback approvals");
    await as(page, "super_admin", "sa-fallback");
    const list = await api(page, "GET", "/api/super-admin/fallback");
    expect(list.data.items.map((i) => i.item_type)).toEqual(expect.arrayContaining(["attendance_correction", "overtime_request"]));
    const res = await api(page, "POST", "/api/super-admin/fallback", { action: "approve", item_type: "attendance_correction", id: requestId, remark: { code: "approve.as_requested" } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect((await rows(db().from("attendance_corrections").select("status,approved_by_name").eq("id", requestId).single())).status).toBe("approved");
    const fixed = await rows(db().from("attendance_logs").select("time_in,time_out").eq("id", log.id).single());
    expect(fixed.time_in && fixed.time_out).toBeTruthy();
  });
});
