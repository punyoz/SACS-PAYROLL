// Attendance correction requests (2026-11-23): the employee files (fix type,
// times, preset reason); limits and the filing window are enforced; HR sees the
// evidence and the pay difference, approves (times applied, the day
// recalculated) or rejects with a preset; a day already on a paid payslip gets
// one approved adjustment on the next payslip; branch / role scope.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay, newRequest, requestTab, writeRemark } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const lastWeekday = (from = 1) => {
  for (let n = from; n < from + 10; n += 1) {
    const d = manilaDay(-n);
    if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) return d;
  }
  return manilaDay(-from);
};
const setSetting = (key, value) => db().from("system_config").update({ value }).eq("section", "attendance").eq("key", key);
const plantAbsent = async (person, day) => {
  psql(`set session_replication_role = replica; delete from attendance_corrections where employee_id = '${person.id}' and log_date = '${day}'; delete from attendance_logs where employee_id = '${person.id}' and log_date = '${day}';`);
  const [log] = await rows(db().from("attendance_logs").insert({ employee_id: person.id, employee_name: person.full_name, branch_id: person.branch_id, log_date: day, status: "Absent" }).select("id"));
  return log.id;
};

test("file → HR approves (day recalculated) / rejects with a preset; limits and window; scope", async ({ page, monitor }) => {
  monitor.allow(/^40[0349] (POST|PATCH|GET) \/api\/attendance\/corrections/, /status of 40[0349]/);
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const day = lastWeekday(1);
  // The weekday before it (strictly earlier: on a Monday both "last weekdays" are Friday).
  let back = 2;
  while (lastWeekday(back) >= day) back += 1;
  const day2 = lastWeekday(back);
  const logId = await plantAbsent(bea, day);
  const logId2 = await plantAbsent(bea, day2);
  await setSetting("correction_max_per_cutoff", "5");

  let requestId;
  await step(page, "Employee > Leave & Overtime > New request > Attendance correction: filled in from the day", async () => {
    monitor.at("Employee > Leave & Overtime > Attendance correction");
    await as(page, "employee2", "emp-leave");
    await settle(page);
    await newRequest(page, "correction");
    const dialog = page.getByRole("dialog", { name: "New request" });
    await dialog.getByTestId("correction-by-date").locator("#corr-date").click();
    await page.keyboard.press("Escape");
    // The form itself (date picking is covered elsewhere): file through the API with the same fields.
    const filed = await api(page, "POST", "/api/attendance/corrections", { log_id: logId, fix_type: "missing_in", time_in: "07:55", time_out: "17:05", reason_code: "card_not_working" });
    expect(filed.status, JSON.stringify(filed.data)).toBe(200);
    requestId = filed.data.correction.id;
    const usage = await api(page, "GET", `/api/attendance/corrections?usage=1&date=${day}`);
    expect(usage.data).toMatchObject({ used: 1, max: 5 });
    await page.keyboard.press("Escape");
    await page.reload();
    await settle(page);
    await requestTab(page, "Attendance correction");
    await expect(main(page).getByTestId("my-correction-requests").getByRole("row").filter({ hasText: day })).toContainText("Pending");
  });

  await step(page, "Rules: one open request per day; the limit per cutoff; the filing window; times on the day", async () => {
    expect((await api(page, "POST", "/api/attendance/corrections", { log_id: logId, fix_type: "missing_in", time_in: "08:00", time_out: "17:00", reason_code: "forgot_in" })).status).toBe(409);
    await setSetting("correction_max_per_cutoff", "1");
    const over = await api(page, "POST", "/api/attendance/corrections", { log_id: logId2, fix_type: "missing_in", time_in: "08:00", time_out: "17:00", reason_code: "forgot_in" });
    expect(over.status).toBe(400);
    expect(over.data.error).toMatch(/used all 1 correction requests/);
    await setSetting("correction_max_per_cutoff", "5");
    const old = await plantAbsent(bea, lastWeekday(20));
    const late = await api(page, "POST", "/api/attendance/corrections", { log_id: old, fix_type: "missing_in", time_in: "08:00", time_out: "17:00", reason_code: "forgot_in" });
    expect(late.status).toBe(400);
    expect(late.data.error).toMatch(/File it within 3 working days/);
    const backwards = await api(page, "POST", "/api/attendance/corrections", { log_id: logId2, fix_type: "missing_in", time_in: "17:00", time_out: "08:00", reason_code: "forgot_in" });
    expect(backwards.status).toBe(400);
    // The employee sees no evidence and decides nothing.
    expect((await api(page, "GET", `/api/attendance/corrections?evidence=${requestId}`)).status).toBe(403);
    expect((await api(page, "PATCH", "/api/attendance/corrections", { correction_id: requestId, decision: "approve", remark: { code: "approve.as_requested" } })).status).toBe(403);
  });

  await step(page, "Admin: no access to the request route (their check is on the Automation card)", async () => {
    await as(page, "admin", "adm-dashboard");
    expect((await api(page, "GET", `/api/attendance/corrections?evidence=${requestId}`)).status).toBe(403);
    const [check] = await rows(db().from("automation_actions").select("status,kind").eq("module", "attendance_corrections").eq("entity_id", requestId));
    expect(check).toMatchObject({ kind: "proposal", status: "admin_check" });
  });

  await step(page, "HR > Leave Approval > Attendance correction requests > Review (evidence, not paid yet) > Approve with a preset", async () => {
    monitor.at("HR > Attendance correction requests");
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).getByTestId("hr-correction-requests");
    const row = card.getByRole("row").filter({ hasText: day });
    await row.getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("dialog");
    await expect(review.getByTestId("correction-evidence")).toContainText("Absent");
    await expect(review.getByTestId("correction-pay")).toContainText("Not paid yet");
    await review.getByRole("button", { name: "Approve" }).click();
    await writeRemark(page, "corr-remark", "", { preset: "Approved as requested" });
    await page.getByRole("dialog").filter({ hasText: "Approve the correction" }).getByRole("button", { name: "Approve" }).click();
    // The dialogs close once it is saved (while one is open, the rows behind it are hidden from the accessibility tree).
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20000 });
    await expect(card.getByRole("row").filter({ hasText: day })).toHaveCount(0, { timeout: 20000 });
    await expect.poll(async () => (await rows(db().from("attendance_corrections").select("status").eq("id", requestId).single())).status, { timeout: 20000 }).toBe("approved");
    const log = await rows(db().from("attendance_logs").select("status,time_in,time_out").eq("id", logId).single());
    expect(log.time_in && log.time_out).toBeTruthy();
    expect(["Absent", "Pending Correction", "Incomplete"]).not.toContain(log.status);
    const saved = await rows(db().from("attendance_corrections").select("status,original_status,original_time_in,pay_correction_id,approved_by_name").eq("id", requestId).single());
    expect(saved).toMatchObject({ status: "approved", original_status: "Absent", original_time_in: null, pay_correction_id: null });
    const [check] = await rows(db().from("automation_actions").select("status").eq("module", "attendance_corrections").eq("entity_id", requestId));
    expect(check.status).toBe("closed");
  });

  await step(page, "Reject with a preset: the day goes back to what the taps say", async () => {
    await as(page, "employee2", "emp-leave");
    const filed = await api(page, "POST", "/api/attendance/corrections", { log_id: logId2, fix_type: "missing_in", time_in: "08:00", time_out: "17:00", reason_code: "other", reason: "I was at the seminar" });
    expect(filed.status, JSON.stringify(filed.data)).toBe(200);
    await as(page, "hr", "hr-leaves");
    const noRemark = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: filed.data.correction.id, decision: "reject" });
    expect(noRemark.status, "a reason is required to reject").toBe(400);
    const rejected = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: filed.data.correction.id, decision: "reject", remark: { code: "reject.incomplete" } });
    expect(rejected.status, JSON.stringify(rejected.data)).toBe(200);
    expect((await rows(db().from("attendance_logs").select("status").eq("id", logId2).single())).status).toBe("Absent");
  });
});

test("a day already on a paid payslip: HR sees the refund first; approval adds ONE approved adjustment for the next payslip", async ({ page, monitor }) => {
  monitor.allow(/^409 PATCH \/api\/attendance\/corrections/, /status of 409/);
  const paid = await rows(db().from("payroll_entries").select("id,employee_id,employee_name,branch_id,pay_period,payroll,status").eq("status", "paid").ilike("pay_period", "October 1-15%").limit(5));
  test.skip(!paid.length, "needs an approved October 1-15 payslip (run after 20-payroll-flow)");
  const entry = paid[0];
  const person = await rows(db().from("profiles").select("id,full_name,branch_id").eq("id", entry.employee_id).single());
  const day = "2026-10-07";
  const logId = await plantAbsent(person, day);
  psql(`set session_replication_role = replica; update attendance_logs set status = 'Pending Correction' where id = '${logId}';`);
  // Filed before the window closed (planted: the filing rules are covered above).
  const [req] = await rows(db().from("attendance_corrections").insert({
    log_id: logId, employee_id: person.id, employee_name: person.full_name, branch_id: person.branch_id, log_date: day,
    original_status: "Absent", corrected_time_in: `${day}T08:00:00+08:00`, corrected_time_out: `${day}T17:00:00+08:00`,
    correction_type: "both", fix_type: "missing_in", reason_code: "card_not_working", reason: "Card not working", requested_by: person.id, requested_by_name: person.full_name,
  }).select("id"));

  await as(page, "hr", "hr-leaves");
  let shown;
  await step(page, "HR > the evidence shows the refund before approving", async () => {
    const ev = await api(page, "GET", `/api/attendance/corrections?evidence=${req.id}`);
    expect(ev.status, JSON.stringify(ev.data)).toBe(200);
    shown = ev.data.evidence.pay;
    expect(shown).toMatchObject({ processed: true, kind: "underpayment" });
    expect(shown.amount).toBeGreaterThan(0);
    expect(shown.text).toMatch(/^Refund ₱/);
    expect(shown.line).toMatch(/^Attendance correction \(Oct 7\): Absent → .+, \+₱/);
  });

  await step(page, "Approve: one approved payroll correction + one incentive line with that text; never twice", async () => {
    const res = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: req.id, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const saved = await rows(db().from("attendance_corrections").select("pay_correction_id,pay_effect").eq("id", req.id).single());
    const pcs = await rows(db().from("payroll_corrections").select("id,status,kind,amount,reason,applied_incentive_id").eq("id", saved.pay_correction_id));
    expect(pcs).toHaveLength(1);
    expect(pcs[0]).toMatchObject({ status: "approved", kind: "underpayment", reason: shown.line });
    expect(Number(pcs[0].amount)).toBe(shown.amount);
    const items = await rows(db().from("payroll_monthly_incentives").select("id,amount,description").eq("description", shown.line));
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(pcs[0].applied_incentive_id);
    const again = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: req.id, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(again.status).toBe(409);
    expect(await rows(db().from("payroll_monthly_incentives").select("id").eq("description", shown.line))).toHaveLength(1);
  });

  await step(page, "Accountant > Dashboard > Action needed lists it (nothing to file)", async () => {
    await as(page, "accountant", "ac-dashboard");
    await settle(page);
    const branchMatches = (await profileByEmail(ACCOUNTS.accountant.email)).branch_id === person.branch_id;
    if (branchMatches) await expect(main(page).getByTestId("attendance-adjustments")).toContainText(shown.line);
  });
});
