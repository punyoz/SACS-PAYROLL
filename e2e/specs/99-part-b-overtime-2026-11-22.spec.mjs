// Part B, step 1 (2026-11-22): overtime is requested ahead, like leave.
//   - The employee files on the Leave page; duplicates and over-limit requests
//     are refused in plain words; a pending request can be cancelled.
//   - HR sees what the system prepared and approves or rejects (a reason is
//     required to reject).
//   - Pay: an approved request pays the smaller of the approved minutes and the
//     minutes worked past the shift end (checked through the real trigger);
//     a late tap out with no request is flagged "Overtime not filed" and pays nothing.
// Screenshots: screenshots/2026-11-22-part-b/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, manilaDay, pickDate, newRequest, requestTab } from "../support/flow.mjs";
import { db, rows, psql, profileByEmail } from "../support/db.mjs";

const OUT = join(process.cwd(), "screenshots", "2026-11-22-part-b");
mkdirSync(OUT, { recursive: true });
const BASE = "/api/me/overtime-requests";

/** A weekday at least `ahead` days from today (Manila). */
function weekdayFrom(ahead) {
  for (let d = ahead; d < ahead + 7; d += 1) {
    const key = manilaDay(d);
    const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return key;
  }
  return manilaDay(ahead);
}

const madeLogs = [];
test.afterAll(() => {
  // Only what this spec made (the app never deletes an overtime request; LOCAL fixture cleanup).
  psql(`set session_replication_role = replica;
    delete from attendance_overtime_approvals where note like 'Overtime request %';
    delete from overtime_requests where reason like 'E2E part B%';
    ${madeLogs.length ? `delete from attendance_logs where id in (${madeLogs.map((id) => `'${id}'`).join(",")});` : ""}`);
});

test("employee files, cancels; duplicates and over-limit refused; HR approves and rejects", async ({ page }) => {
  const date = weekdayFrom(3);
  const other = weekdayFrom(5) === date ? weekdayFrom(6) : weekdayFrom(5);
  // Start clean on both days: another spec may have left Bea an open request on one of them
  // (one open request per day is a rule; 2026-11-24 full run: 99-leave-overtime used Nov 30).
  const bea0 = await profileByEmail(ACCOUNTS.employee2.email);
  await db().from("overtime_requests").delete().eq("employee_id", bea0.id).in("request_date", [date, other]);

  await as(page, "employee2", "emp-leave");
  await settle(page);
  const otForm = await newRequest(page, "overtime");
  await expect(otForm).toContainText("Up to 3 h a day and 10 h a cutoff");
  await pickDate(page, otForm.locator("#ot-date"), date);
  await otForm.locator("#ot-start").fill("17:00");
  await otForm.locator("#ot-end").fill("19:00");
  await otForm.locator("#ot-reason").fill("E2E part B: grade encoding");
  await otForm.getByRole("button", { name: "File overtime request" }).click();
  // Filed: the dialog closes and the Overtime tab shows it.
  const card = main(page).getByTestId("my-overtime-requests");
  await expect(card).toBeVisible();
  await expect(card.getByRole("row").filter({ hasText: date })).toContainText("Pending");
  await card.screenshot({ path: join(OUT, "employee-filed.png") });

  // Same day again, and more than 3 h: refused in plain words.
  const again = await api(page, "POST", BASE, { request_date: date, planned_start: "18:00", planned_end: "19:00", reason: "E2E part B: again" });
  expect(again.status).toBe(400);
  expect(again.data.error).toMatch(/already have an overtime request for/);
  const long = await api(page, "POST", BASE, { request_date: other, planned_start: "17:00", planned_end: "21:00", reason: "E2E part B: long" });
  expect(long.data.error).toBe("Overtime is at most 3 h a day. This request is 4 h.");
  const old = await api(page, "POST", BASE, { request_date: manilaDay(-5), planned_start: "17:00", planned_end: "18:00", reason: "E2E part B: old" });
  expect(old.data.error).toMatch(/late filing/);

  // Cancel a pending one.
  const second = await api(page, "POST", BASE, { request_date: other, planned_start: "17:00", planned_end: "18:00", reason: "E2E part B: to cancel" });
  expect(second.status, JSON.stringify(second.data)).toBe(201);
  await page.reload();
  await settle(page);
  await requestTab(page, "Overtime");
  const row = card.getByRole("row").filter({ hasText: other });
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toContainText("Cancelled");

  // Another employee's request cannot be cancelled by this one.
  const anaRequest = (await rows(db().from("overtime_requests").insert({ employee_id: (await profileByEmail("emp1@e2e.test")).id, request_date: other, planned_start: "17:00", planned_end: "18:00", minutes: 60, reason: "E2E part B: Ana's" }).select("id")))[0];
  const foreign = await api(page, "PATCH", BASE, { id: anaRequest.id, action: "cancel" });
  expect(foreign.status).toBe(409);

  // HR: the prepared facts, approve one, reject one (a reason is required).
  await as(page, "hr", "hr-leaves");
  await settle(page);
  const hr = main(page).getByTestId("hr-overtime-requests");
  await expect(hr).toBeVisible();
  const bea = hr.getByRole("row").filter({ hasText: date });
  await expect(bea.getByTestId("ot-facts")).toContainText("Requested 2 h; paid after the time-out tap if approved");
  await expect(bea.getByTestId("ot-facts")).toContainText("Allowed for this employee's category");
  await hr.screenshot({ path: join(OUT, "hr-pending.png") });
  await bea.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  // The modal hides the table from the accessibility tree: wait for it to close first.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(bea).toHaveCount(0); // left the Pending list

  const noReason = await api(page, "PATCH", "/api/hr/overtime-requests", { id: anaRequest.id, decision: "reject" });
  expect(noReason.data.error).toBe("Choose a remark (a reason is required).");
  const ana = hr.getByRole("row").filter({ hasText: other });
  await ana.getByRole("button", { name: "Reject" }).click();
  const dialog = page.getByRole("dialog");
  // Part H: a rejection needs a remark; the preset carries extra words.
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(dialog.getByText("Choose a remark (a reason is required).")).toBeVisible();
  await choose(page, dialog.locator("#ot-remark-preset"), "Not needed for the task");
  await dialog.locator("#ot-remark-extra").fill("this week");
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(dialog).toBeHidden();
  await expect(ana).toHaveCount(0);

  const decided = await rows(db().from("overtime_requests").select("status,decision_note").in("id", [anaRequest.id]));
  expect(decided[0]).toEqual({ status: "rejected", decision_note: "Not needed for the task: this week" });
  const audited = await rows(db().from("audit_logs").select("metadata").eq("entity_id", anaRequest.id).eq("metadata->>kind", "decision_remark"));
  expect(audited.map((a) => a.metadata.remark_code)).toEqual(["reject.overtime.not_needed"]);

  // The employee may not decide anything.
  await as(page, "employee2", "emp-leave");
  const denied = await api(page, "PATCH", "/api/hr/overtime-requests", { id: anaRequest.id, decision: "approve" });
  expect(denied.status).toBe(403);
});

test("pay: approved pays min(approved, worked); no request is flagged and pays nothing", async ({ page }) => {
  const bea = await profileByEmail("emp2@e2e.test");
  const ana = await profileByEmail("emp1@e2e.test");
  const day = manilaDay(-1); // late filing (within 2 days)
  const log = (p, outTime) => ({
    employee_id: p.id, employee_name: p.full_name, employee_type: p.employee_type, branch_id: p.branch_id, log_date: day,
    time_in: `${day}T08:00:00+08:00`, time_out: `${day}T${outTime}:00+08:00`, status: "Present",
  });
  psql(`set session_replication_role = replica; delete from attendance_logs where log_date = '${day}' and employee_id in ('${bea.id}', '${ana.id}');`);
  const [beaLog] = await rows(db().from("attendance_logs").insert(log(bea, "17:00")).select("id"));
  const [anaLog] = await rows(db().from("attendance_logs").insert(log(ana, "19:30")).select("id"));
  madeLogs.push(beaLog.id, anaLog.id);

  await as(page, "employee2", "emp-leave");
  const filed = await api(page, "POST", BASE, { request_date: day, planned_start: "17:00", planned_end: "19:00", reason: "E2E part B: pay check" });
  expect(filed.status, JSON.stringify(filed.data)).toBe(201);
  expect(filed.data.request.late_filing).toBe(true);

  await as(page, "hr", "hr-leaves");
  const approved = await api(page, "PATCH", "/api/hr/overtime-requests", { id: filed.data.request.id, decision: "approve" });
  expect(approved.status, JSON.stringify(approved.data)).toBe(200);
  expect(approved.data.request.facts.pay_text).toBe("Approved 2 h, worked 0 h → 0 h paid");

  // The time-out tap arrives later: 18:15 → 75 minutes paid of 120 approved.
  await db().from("attendance_logs").update({ time_out: `${day}T18:15:00+08:00` }).eq("id", beaLog.id);
  const [paid] = await rows(db().from("attendance_overtime_approvals").select("overtime_minutes,approved_minutes,status").eq("log_id", beaLog.id));
  expect(paid).toEqual({ overtime_minutes: 75, approved_minutes: 75, status: "approved" });
  const facts = await api(page, "GET", "/api/hr/overtime-requests?status=approved");
  expect(facts.data.requests.find((r) => r.id === filed.data.request.id).facts.pay_text).toBe("Approved 2 h, worked 1 h 15 min → 1 h 15 min paid");

  // Ana left at 19:30 with no request: listed, flagged, nothing approved.
  const board = await api(page, "GET", `/api/attendance/overtime?from=${day}&to=${day}`);
  const anaRow = board.data.overtime.find((r) => r.employee_id === ana.id);
  expect(anaRow).toMatchObject({ flag: "Overtime not filed", approval: null });
  const beaRow = board.data.overtime.find((r) => r.employee_id === bea.id);
  expect(beaRow).toMatchObject({ flag: null, request: { status: "approved", minutes: 120 } });
});
