// Part E step 6 (2026-11-23, timing changed the same day): Perfect Attendance
// waits for HR, and is recommended only once the cutoff's attendance is
// complete (the nightly close ran for its last day).
//  - While the cutoff is open: the draft says "on track so far", pays ₱0,
//    and nothing goes to HR's list.
//  - After the close: one recommendation per employee / period / kind. An
//    absence added later withdraws it; re-saved, it is pending again (one row).
//    HR approves; recomputed, it is paid. A change after the approval flags
//    it for HR instead of changing it.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const OPEN_PERIOD = "November 16-30, 2026";
const CLOSED_PERIOD = "October 16-31, 2026";
const BONUS = 500;
let planted = null;

test.describe.configure({ mode: "serial" });

test.afterEach(() => {
  if (!planted) return;
  psql(`set session_replication_role = replica;
    delete from payroll_rate_configs where id = '${planted.rate}';
    update system_config set value = '${planted.from}' where section = 'automation' and key = 'incentive_approval_from';`);
  planted = null;
});

const recs = (employeeId, periodStart) => rows(db().from("incentive_recommendations").select("id,status,amount,needs_review")
  .eq("employee_id", employeeId).eq("period_start", periodStart).eq("kind", "perfect_attendance"));

async function draft(page, person, period) {
  await as(page, "accountant", "ac-process");
  const res = await api(page, "POST", "/api/accountant/payroll", { action: "save_draft", employee_id: person.id, pay_period: period });
  expect(res.status, `save_draft ${period}: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(200);
  return rows(db().from("payroll_entries").select("payroll").eq("employee_id", person.id).eq("pay_period", period).eq("status", "draft").single());
}

/** Planted with triggers off (local only): a rate change needs the account that made it. */
function plantBonus(from) {
  const current = psql("select value from system_config where section = 'automation' and key = 'incentive_approval_from';");
  const rate = psql(`set session_replication_role = replica;
    insert into payroll_rate_configs (rate_type, scope, value, effective_date, note, created_by_name)
    values ('perfect_attendance_bonus', 'global', ${BONUS}, '2026-09-01', 'E2E step 6', 'E2E') returning id;`).split(/\s+/).filter(Boolean).pop();
  psql(`update system_config set value = '${from}' where section = 'automation' and key = 'incentive_approval_from';`);
  planted = { rate, from: current };
}

/** On time (08:00-17:00) every weekday from `from` to the day before `to`. */
async function plantOnTime(person, from, to) {
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); new Date(t).toISOString().slice(0, 10) < to; t += 864e5) {
    if (![0, 6].includes(new Date(t).getUTCDay())) days.push(new Date(t).toISOString().slice(0, 10));
  }
  psql(`set session_replication_role = replica; delete from incentive_recommendations where employee_id = '${person.id}';
    delete from attendance_logs where employee_id = '${person.id}' and log_date between '${from}' and '${to}';`);
  await rows(db().from("attendance_logs").insert(days.map((day) => ({
    employee_id: person.id, employee_name: person.full_name, branch_id: person.branch_id, log_date: day, status: "Present",
    time_in: `${day}T07:55:00+08:00`, time_out: `${day}T17:05:00+08:00`, shift_start_minutes: 480, shift_end_minutes: 1020,
  }))).select("id"));
  return days;
}

/** A copy of Bea in her branch with no payslips yet (as 99-process-page-cleanup does), hired before September. */
async function freshEmployee() {
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  const stamp = Date.now();
  const email = `incentive.${stamp}@e2e.test`;
  const full_name = "Ines E2E Incentive";
  const { data, error } = await db().auth.admin.createUser({ email, password: `E2e-In#${stamp}`, email_confirm: true, user_metadata: { role: "employee", full_name, branch_id: bea.branch_id } });
  if (error) throw new Error(error.message);
  const { id: _id, email: _email, created_at: _c, updated_at: _u, rfid_uid: _card, photo_path: _p, photo_thumb_path: _t, photo_updated_at: _pu, ...rest } = bea;
  await rows(db().from("profiles").upsert({ ...rest, id: data.user.id, email, full_name, employee_id: `E2E-IN-${stamp}`, archived: false, on_payroll: true, date_hired: "2025-06-01" }, { onConflict: "id" }).select("id"));
  // The staff list is cached for 10 s: the Accountant sees the new employee after that.
  await new Promise((r) => setTimeout(r, 11000));
  return profileByEmail(email);
}

test("open cutoff: Perfect Attendance is 'on track so far', ₱0, nothing sent to HR", async ({ page, monitor }) => {
  monitor.at("Part E step 6 (cutoff open)");
  test.skip(manilaDay(0) < "2026-11-17" || manilaDay(0) > "2026-11-26", "written for a day while the November 16-30 attendance window (to Nov 26) is open");
  // Bea (Main branch, where the Accountant works).
  const bea = await profileByEmail(ACCOUNTS.employee2.email);
  plantBonus("2026-11-16");
  await plantOnTime(bea, "2026-10-26", manilaDay(0));

  await step(page, "Draft while the window is open: computed, held, 'on track so far'; no recommendation", async () => {
    const entry = await draft(page, bea, OPEN_PERIOD);
    const item = (entry.payroll.rule_incentives?.items || []).find((i) => i.kind === "perfect_attendance");
    expect(item, JSON.stringify(entry.payroll.audit?.attendance?.counts)).toMatchObject({ amount: BONUS, paid: false, status: "on_track" });
    expect(entry.payroll.rule_incentives.closed).toBe(false);
    expect(Number(entry.payroll.totals.perfect_attendance_incentive)).toBe(0);
    expect(await recs(bea.id, "2026-11-16")).toEqual([]);
  });

  await step(page, "The Accountant's form says so; HR's list has nothing for her", async () => {
    await as(page, "accountant", "ac-process");
    const list = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(OPEN_PERIOD)}`);
    const row = (list.data.attendance_rows || list.data.rows || []).find((r) => r.employee_id === bea.id);
    if (row) expect(row.rule_incentives?.items?.[0]?.status).toBe("on_track");
    await as(page, "hr", "hr-adjustment-approvals");
    const hr = await api(page, "GET", "/api/hr/adjustment-approvals?status=all");
    expect(hr.data.items.filter((i) => i.kind === "rule_incentive" && i.employee_id === bea.id)).toEqual([]);
  });
});

test("closed cutoff: recommended once; absence added → withdrawn; re-saved → pending; HR approves → paid; later change → flagged", async ({ page, monitor }) => {
  monitor.at("Part E step 6 (cutoff closed)");
  const ines = await freshEmployee();
  plantBonus("2026-10-16");
  const days = await plantOnTime(ines, "2026-09-26", "2026-11-01");
  const periodStart = "2026-10-16";

  await step(page, "Draft after the close: one recommendation, pending, held (₱0)", async () => {
    const entry = await draft(page, ines, CLOSED_PERIOD);
    const item = (entry.payroll.rule_incentives?.items || []).find((i) => i.kind === "perfect_attendance");
    expect(item, JSON.stringify(entry.payroll.audit?.attendance?.counts)).toMatchObject({ amount: BONUS, paid: false, status: "pending" });
    expect(entry.payroll.rule_incentives.closed).toBe(true);
    expect(Number(entry.payroll.totals.perfect_attendance_incentive)).toBe(0);
    expect(await recs(ines.id, periodStart)).toMatchObject([{ status: "pending", amount: BONUS }]);
    // Saved again unchanged: still one row.
    await draft(page, ines, CLOSED_PERIOD);
    expect(await recs(ines.id, periodStart)).toHaveLength(1);
  });

  await step(page, "An absence is added inside the window: withdrawn; removed and re-saved: pending again, one row", async () => {
    const sat = days.filter((d) => d >= "2026-10-16").map((d) => Date.parse(`${d}T00:00:00Z`)).map((t) => t + 864e5).map((t) => new Date(t))
      .find((d) => d.getUTCDay() === 6).toISOString().slice(0, 10);
    const [absence] = await rows(db().from("attendance_logs").insert({ employee_id: ines.id, employee_name: ines.full_name, branch_id: ines.branch_id, log_date: sat, status: "Absent" }).select("id"));
    expect(await recs(ines.id, periodStart)).toMatchObject([{ status: "withdrawn" }]);
    psql(`set session_replication_role = replica; delete from attendance_logs where id = '${absence.id}';`);
    await draft(page, ines, CLOSED_PERIOD);
    expect(await recs(ines.id, periodStart)).toMatchObject([{ status: "pending", amount: BONUS }]);
  });

  let recId;
  await step(page, "HR sees it on Incentive & loan approvals and approves it (decided once)", async () => {
    await as(page, "hr", "hr-adjustment-approvals");
    const list = await api(page, "GET", "/api/hr/adjustment-approvals?status=pending");
    const mine = list.data.items.find((i) => i.kind === "rule_incentive" && i.employee_id === ines.id);
    expect(mine).toMatchObject({ type_label: "Perfect Attendance (system)", approval_status: "pending", filed_by: "System (rule)" });
    recId = mine.id;
    const res = await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: "rule_incentive", id: mine.id, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const again = await api(page, "PATCH", "/api/hr/adjustment-approvals", { kind: "rule_incentive", id: mine.id, decision: "approve", remark: { code: "approve.as_requested" } });
    expect(again.status, "decided once").toBeGreaterThanOrEqual(400);
  });

  await step(page, "Recomputed: paid once; a later attendance change flags it for HR, it stays approved", async () => {
    const entry = await draft(page, ines, CLOSED_PERIOD);
    expect(Number(entry.payroll.totals.perfect_attendance_incentive)).toBe(BONUS);
    expect((entry.payroll.rule_incentives.items || []).find((i) => i.kind === "perfect_attendance")).toMatchObject({ paid: true });
    // Oct 20 (inside the window) becomes 20 minutes late; triggers on, as a correction or an override would.
    psql(`update attendance_logs set time_in = '2026-10-20T08:20:00+08:00', late_minutes = 20, status = 'Late' where employee_id = '${ines.id}' and log_date = '2026-10-20';`);
    const [rec] = await recs(ines.id, periodStart);
    expect(rec).toMatchObject({ status: "approved", needs_review: expect.stringMatching(/changed after HR approved it/) });
    expect(await rows(db().from("automation_actions").select("id").eq("module", "incentive_recommendations").eq("entity_id", recId))).toHaveLength(1);
  });
});
