// RFID tap → attendance record → payroll: runs after 60-rfid-flow, which tapped
// Ana's card today. The Accountant's payroll attendance for the period that
// holds today must count that day (deployment-readiness audit, 2026-10-27).
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const periodOf = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= 15 ? `${month} 1-15, ${y}` : `${month} 16-${last}, ${y}`;
};

test("today's RFID tap is counted in the Accountant's payroll attendance", async ({ page, monitor }) => {
  const ana = await profileByEmail(ACCOUNTS.employee.email);
  const today = manilaDay(0);
  const logs = await rows(db().from("attendance_logs").select("id,status,time_in,change_source").eq("employee_id", ana.id).eq("log_date", today));
  expect(logs.length, "60-rfid-flow left today's tap").toBe(1);
  expect(logs[0].time_in).toBeTruthy();
  const taps = await rows(db().from("attendance_taps").select("id").eq("employee_id", ana.id).eq("log_date", today));
  expect(taps.length, "the raw tap is kept").toBeGreaterThan(0);

  await step(page, `Accountant > Process Payroll (${periodOf(today)}) > Ana's attendance counts today`, async () => {
    monitor.at("Accountant > payroll attendance");
    await as(page, "accountant");
    const res = await api(page, "GET", `/api/accountant/payroll?period=${encodeURIComponent(periodOf(today))}`);
    expect(res.status).toBe(200);
    const row = (res.data.attendance_rows || []).find((r) => r.employee_id === ana.id);
    expect(row, "Ana is in the Accountant's branch").toBeTruthy();
    const status = String(logs[0].status || "").toLowerCase();
    if (status === "present" || status === "late") expect(row.present_days).toBeGreaterThan(0);
    else expect(row.present_days + row.unresolved_days, `today is "${logs[0].status}"`).toBeGreaterThan(0);
  });
});
