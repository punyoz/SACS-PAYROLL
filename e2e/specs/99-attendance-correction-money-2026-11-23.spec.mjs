// Attendance correction requests: the money path (2026-11-23). A correction
// approved for a day already on a paid payslip -> the next payslip is processed
// -> the adjustment line is there exactly once with the right amount, the net
// pay moves by exactly that amount, and processing it again does not add it
// twice. A refund (Absent -> present) and a reduction (late minutes added).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const toAmount = (n) => Math.round(Number(n) * 100) / 100;
const occurrences = (payroll, text) => JSON.stringify(payroll).split(text).length - 1;

async function plantPaidDayRequest(person, day, { status, timeIn, timeOut, fix, correctedIn, correctedOut }) {
  psql(`set session_replication_role = replica; delete from attendance_corrections where employee_id = '${person.id}' and log_date = '${day}'; delete from attendance_logs where employee_id = '${person.id}' and log_date = '${day}';`);
  const [log] = await rows(db().from("attendance_logs").insert({
    employee_id: person.id, employee_name: person.full_name, branch_id: person.branch_id, log_date: day, status,
    time_in: timeIn, time_out: timeOut, shift_start_minutes: 480, shift_end_minutes: 1020,
  }).select("id,status,late_minutes"));
  psql(`set session_replication_role = replica; update attendance_logs set status = 'Pending Correction' where id = '${log.id}';`);
  // Filed in time (the filing window is covered in 99-attendance-correction-requests).
  const [req] = await rows(db().from("attendance_corrections").insert({
    log_id: log.id, employee_id: person.id, employee_name: person.full_name, branch_id: person.branch_id, log_date: day,
    original_status: log.status, original_time_in: timeIn, original_time_out: timeOut, original_late_minutes: log.late_minutes,
    corrected_time_in: correctedIn, corrected_time_out: correctedOut, correction_type: correctedOut && correctedIn ? "both" : correctedIn ? "time_in" : "time_out",
    fix_type: fix, reason_code: "forgot_in", reason: "E2E money path", requested_by: person.id, requested_by_name: person.full_name,
  }).select("id"));
  return req.id;
}

async function draftOf(page, person, period) {
  await as(page, "accountant", "ac-process");
  const res = await api(page, "POST", "/api/accountant/payroll", { action: "save_draft", employee_id: person.id, pay_period: period });
  expect(res.status, `save_draft ${period}: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(200);
  return rows(db().from("payroll_entries").select("id,net_pay,payroll,status").eq("employee_id", person.id).eq("pay_period", period).eq("status", "draft").single());
}

async function approve(page, id) {
  await as(page, "hr", "hr-leaves");
  const ev = await api(page, "GET", `/api/attendance/corrections?evidence=${id}`);
  expect(ev.status, JSON.stringify(ev.data).slice(0, 300)).toBe(200);
  const res = await api(page, "PATCH", "/api/attendance/corrections", { correction_id: id, decision: "approve", remark: { code: "approve.as_requested" } });
  expect(res.status, JSON.stringify(res.data).slice(0, 300)).toBe(200);
  return { shown: ev.data.evidence.pay, pay: res.data.pay };
}

test.describe.configure({ mode: "serial" });

test("refund: Absent -> present on a paid day; the next payslip carries +amount once; net pay up by exactly that", async ({ page, monitor }) => {
  monitor.at("Money path (refund)");
  const paid = await rows(db().from("payroll_entries").select("id").eq("status", "paid").ilike("pay_period", "October 1-15%"));
  test.skip(!paid.length, "needs an approved October 1-15 payslip (run after 20-payroll-flow)");
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const NEXT = "November 16-30, 2026";
  const before = await draftOf(page, ana, NEXT);
  const id = await plantPaidDayRequest(ana, "2026-10-07", { status: "Absent", timeIn: null, timeOut: null, fix: "missing_in",
    correctedIn: "2026-10-07T08:00:00+08:00", correctedOut: "2026-10-07T17:00:00+08:00" });
  let line;
  let amount;
  await step(page, "HR approves: the refund shown first is the one applied", async () => {
    const { shown, pay } = await approve(page, id);
    expect(shown.kind).toBe("underpayment");
    expect(pay).toMatchObject({ kind: "underpayment", amount: shown.amount, line: shown.line });
    ({ line, amount } = pay);
    expect(amount).toBeGreaterThan(0);
  });
  await step(page, "Accountant processes the next payslip: the line once, the net pay + amount", async () => {
    const after = await draftOf(page, ana, NEXT);
    expect(occurrences(after.payroll, line), "the adjustment line, once").toBe(1);
    expect(toAmount(after.net_pay - before.net_pay)).toBe(toAmount(amount));
  });
  await step(page, "Processing it again does not add it twice", async () => {
    const again = await draftOf(page, ana, NEXT);
    expect(occurrences(again.payroll, line)).toBe(1);
    expect(toAmount(again.net_pay - before.net_pay)).toBe(toAmount(amount));
  });
});

// With the seeded rates late minutes cost nothing (late_minute_charge_pct 0), so a later time in changes no pay
// (shown as "No change"): the reduction case is an earlier time out (a short day), which does cost.
test("reduction: a paid day becomes a short day; recovered once on the next 2nd half; net pay down by exactly that", async ({ page, monitor }) => {
  monitor.at("Money path (reduction)");
  const paid = await rows(db().from("payroll_entries").select("id").eq("status", "paid").ilike("pay_period", "October 1-15%"));
  test.skip(!paid.length, "needs an approved October 1-15 payslip (run after 20-payroll-flow)");
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  // The recovery starts on the next 2nd half (deductions are taken on the 16-end payslip).
  const today = new Date(Date.now() + 8 * 3600e3);
  const nextSecond = today.getUTCDate() <= 16 ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 16)) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 16));
  const monthName = nextSecond.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const last = new Date(Date.UTC(nextSecond.getUTCFullYear(), nextSecond.getUTCMonth() + 1, 0)).getUTCDate();
  const NEXT = `${monthName} 16-${last}, ${nextSecond.getUTCFullYear()}`;
  const before = await draftOf(page, ana, NEXT);
  const id = await plantPaidDayRequest(ana, "2026-10-08", { status: "On Time", timeIn: "2026-10-08T08:00:00+08:00", timeOut: "2026-10-08T17:00:00+08:00", fix: "wrong_out",
    correctedIn: null, correctedOut: "2026-10-08T12:00:00+08:00" });
  let line;
  let amount;
  await step(page, "HR approves: the deduction shown first (never silent) is the one applied", async () => {
    const { shown, pay } = await approve(page, id);
    expect(shown.kind).toBe("overpayment");
    expect(shown.text).toMatch(/^Deduct ₱/);
    expect(pay).toMatchObject({ kind: "overpayment", amount: shown.amount, line: shown.line });
    ({ line, amount } = pay);
  });
  await step(page, "Accountant processes the next 2nd half: recovered once, the net pay - amount", async () => {
    const after = await draftOf(page, ana, NEXT);
    expect(occurrences(after.payroll, line), "the recovery line, once").toBe(1);
    expect(toAmount(before.net_pay - after.net_pay)).toBe(toAmount(amount));
    const again = await draftOf(page, ana, NEXT);
    expect(occurrences(again.payroll, line)).toBe(1);
    expect(toAmount(before.net_pay - again.net_pay)).toBe(toAmount(amount));
  });
});
