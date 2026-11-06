// Leave, the cases 30-leave-flow does not cover: no proof file, without pay,
// overlapping dates, HR rejecting (and the employee's notification), and
// what approved leave does to payroll: with pay = no deduction, without pay =
// a deduction, each leave day counted once. The test's leaves are cancelled at
// the end so later specs see Ana's November as before.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, choose, confirm, manilaDay, pickDate, refresh } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const TAG = `E2E-LV-${Date.now().toString(36)}`;
// Weekdays in the 2nd half of the month 13-20 days ahead (7-day notice rule).
function weekdayFrom(offset) {
  for (let d = offset; d < offset + 7; d += 1) {
    const key = manilaDay(d);
    const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 3) return d; // Mon-Wed, so +1 and +2 are weekdays too
  }
  return offset;
}
const BASE = weekdayFrom(13);
const D1 = manilaDay(BASE), D2 = manilaDay(BASE + 1), D3 = manilaDay(BASE + 2);
const DR = manilaDay(BASE + 7);

function periodOf(key) {
  const [y, m, d] = key.split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= 15 ? `${month} 1-15, ${y}` : `${month} 16-${last}, ${y}`;
}

// Ana's November stays as before for later specs, even when a check fails.
test.afterAll(async () => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  await db().from("leave_requests").update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("employee_id", ana.id).like("reason", `${TAG}%`).in("status", ["approved", "pending_admin", "pending_accountant"]);
});

test("leave extras: no proof / without pay, overlap refused, HR rejects + notice, payroll effect", async ({ page, monitor }) => {
  monitor.allow(/^409 POST \/api\/employee\/leave-requests/, /status of 409/);
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const mine = async (reason) => rows(db().from("leave_requests").select("id,status,pay_status,proof_url,start_date,end_date").eq("employee_id", ana.id).eq("reason", reason));
  const made = [];

  await step(page, `Employee Ana > Leave > Vacation Leave WITHOUT pay ${D1} to ${D2}, no proof file`, async () => {
    monitor.at("Employee > Leave");
    await as(page, "employee", "emp-leave");
    const form = main(page).locator("form").first();
    await choose(page, form.getByRole("combobox").first(), "Vacation Leave");
    await choose(page, form.getByRole("combobox").nth(1), "Without pay");
    await pickDate(page, form.getByLabel("Start date"), D1);
    await pickDate(page, form.getByLabel("End date"), D2);
    await form.getByPlaceholder("State the reason for your leave request").fill(`${TAG} unpaid`);
    await form.getByRole("button", { name: /Submit/ }).click();
    await settle(page);
    await expect(main(page).getByRole("cell", { name: `${TAG} unpaid` })).toBeVisible();
    const saved = await mine(`${TAG} unpaid`);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ pay_status: "without_pay", start_date: D1, end_date: D2 });
    expect(saved[0].proof_url || null, "no proof was attached").toBeNull();
    made.push(saved[0].id);
  });

  await step(page, `Employee Ana > Leave > a WITH-pay leave ${D2} to ${D3} overlapping it (refused)`, async () => {
    const res = await api(page, "POST", "/api/employee/leave-requests", { leave_type: "Sick Leave", pay_status: "with_pay", start_date: D2, end_date: D3, reason: `${TAG} overlap`, employee_name: "Ana Lopez" });
    console.log(`  · overlapping leave answered ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
    const saved = await mine(`${TAG} overlap`);
    if (saved.length) made.push(saved[0].id);
    expect(res.status, "a leave overlapping a pending one must be refused").toBe(409);
    expect(saved).toHaveLength(0);
  });

  await step(page, `Employee Ana > Leave > a WITH-pay leave on ${D3} only (no overlap) and a Sick Leave on ${DR}`, async () => {
    const paid = await api(page, "POST", "/api/employee/leave-requests", { leave_type: "Sick Leave", pay_status: "with_pay", start_date: D3, end_date: D3, reason: `${TAG} paid`, employee_name: "Ana Lopez" });
    expect(paid.status, JSON.stringify(paid.data)).toBe(201);
    const toReject = await api(page, "POST", "/api/employee/leave-requests", { leave_type: "Sick Leave", pay_status: "with_pay", start_date: DR, end_date: DR, reason: `${TAG} to reject`, employee_name: "Ana Lopez" });
    expect(toReject.status, JSON.stringify(toReject.data)).toBe(201);
    made.push((await mine(`${TAG} paid`))[0].id, (await mine(`${TAG} to reject`))[0].id);
  });

  await step(page, "HR > Leave Approval > Reject Ana's Sick Leave", async () => {
    monitor.at("HR > Leave Approval");
    await as(page, "hr", "hr-leaves");
    await settle(page);
    const card = main(page).locator("li", { hasText: `${TAG} to reject` });
    await card.getByRole("button", { name: "Reject" }).click();
    await confirm(page, "Reject");
    await expect.poll(async () => (await mine(`${TAG} to reject`))[0].status, { timeout: 30000 }).toBe("rejected");
  });

  await step(page, "HR > Leave Approval > Approve the unpaid and the paid leave", async () => {
    for (const reason of [`${TAG} unpaid`, `${TAG} paid`]) {
      const card = main(page).locator("li", { hasText: reason });
      await card.getByRole("button", { name: "Approve" }).click();
      await confirm(page, "Approve");
      await expect.poll(async () => (await mine(reason))[0].status, { timeout: 30000 }).toBe("approved");
    }
  });

  await step(page, "Employee Ana > Leave shows Rejected and Approved; the bell has the rejection notice", async () => {
    monitor.at("Employee > Leave (decisions)");
    await as(page, "employee", "emp-leave");
    await refresh(page);
    await expect(main(page).locator("tr", { hasText: `${TAG} to reject` }).getByText(/Rejected/i)).toBeVisible();
    await expect(main(page).locator("tr", { hasText: `${TAG} unpaid` }).getByText(/Approved/i)).toBeVisible();
    const notes = await api(page, "GET", "/api/notifications");
    expect(notes.status).toBe(200);
    expect(JSON.stringify(notes.data), "a leave rejection notice reached Ana").toMatch(/reject/i);
  });

  await step(page, `Accountant > ${periodOf(D1)} preview: 2 days without pay (deducted), 1 day with pay (not deducted), nothing counted twice`, async () => {
    monitor.at("Accountant > Process Payroll (leave)");
    await as(page, "accountant");
    const res = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(periodOf(D1))}`);
    expect(res.status).toBe(200);
    const summary = (res.data.leave_summary || []).find((s) => s.employee_id === ana.id);
    expect(summary, "Ana's leave summary").toBeTruthy();
    // Only this test's days (30-leave-flow may have approved other days of Ana's).
    const ours = (list) => (list || []).filter((d) => [D1, D2, D3].includes(d));
    expect(ours(summary.without_pay_dates)).toEqual([D1, D2]);
    expect(ours(summary.with_pay_dates)).toEqual([D3]);
    const all = [...(summary.without_pay_dates || []), ...(summary.with_pay_dates || [])];
    expect(new Set(all).size, "no day is counted twice").toBe(all.length);
    expect(summary.without_pay_days).toBe(summary.without_pay_dates.length);
    expect(summary.with_pay_days).toBe(summary.with_pay_dates.length);
    // The Process Payroll form pre-fills Leave without pay / with pay from
    // this summary (the deduction is days × daily rate; with pay deducts nothing).
  });

  await step(page, "HR > cancels the test's approved leaves (clean-up)", async () => {
    monitor.at("HR > Leave Approval (clean-up)");
    await as(page, "hr", "hr-leaves");
    for (const id of made) {
      const r = (await rows(db().from("leave_requests").select("status").eq("id", id)))[0];
      if (r && ["approved", "pending_admin", "pending_accountant"].includes(r.status)) {
        const res = await api(page, "PATCH", "/api/hr/leave-requests", { id, action: r.status === "approved" ? "cancel" : "reject" });
        expect([200, 201], JSON.stringify(res.data)).toContain(res.status);
      }
    }
  });
});
