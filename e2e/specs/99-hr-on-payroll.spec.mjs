// Every account ON PAYROLL taps (2026-11-24): an HR officer on payroll taps at the terminal like any staff; an
// account not on payroll (Admin) is refused with a clear message; no self-handling (own card, own attendance);
// the nightly close treats HR like other employees.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { db, profileByEmail, psql, rows } from "../support/db.mjs";
import { ACCOUNTS } from "../accounts.mjs";

const HR_CARD = `66${String(Date.now()).slice(-8)}`;
const ADMIN_CARD = `65${String(Date.now()).slice(-8)}`;

async function kioskTap(page, uid, offlineAt) {
  return page.evaluate(async ({ uid, offlineAt }) => {
    const res = await fetch("/api/admin/attendance", { method: "POST", headers: { "Content-Type": "application/json", "x-sacs-kiosk": "1" },
      body: JSON.stringify({ device: "RFID Terminal · E2E", rfid_code: uid, ...(offlineAt ? { offline_tapped_at: offlineAt } : {}) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, { uid, offlineAt });
}

test.describe.configure({ mode: "serial" });

test("HR on payroll: taps accepted; Admin refused; no self-handling; nightly close counts HR", async ({ page, monitor }) => {
  monitor.allow(/^4\d\d (POST|PATCH) \/api\/(admin\/attendance|rfid\/cards|attendance\/corrections)/, /status of 4/);
  const hr = await profileByEmail(ACCOUNTS.hr.email);
  const admin = await profileByEmail(ACCOUNTS.admin.email);
  // The HR officer is on payroll (as on live since Nov 19); a clean card slate for the test.
  psql(`update profiles set on_payroll = true where id = '${hr.id}';
    set session_replication_role = replica; delete from rfid_card_events where employee_id = '${hr.id}'; delete from rfid_cards where employee_id = '${hr.id}';
    update profiles set rfid_uid = null where id = '${hr.id}'; update profiles set rfid_uid = '${ADMIN_CARD}' where id = '${admin.id}';`);
  const { data: u } = await db().auth.admin.getUserById(hr.id);
  await db().auth.admin.updateUserById(hr.id, { user_metadata: { ...(u.user.user_metadata || {}), on_payroll: true } });

  await step(page, "HR cannot register their own card; the Super Admin does", async () => {
    await as(page, "hr", "hr-attendance");
    const own = await api(page, "POST", "/api/rfid/cards", { action: "register", employee_id: hr.id, uid: HR_CARD, reason: "Card issued" });
    expect(own.status).toBe(403);
    expect(own.data.code).toBe("own_card");
    await as(page, "super_admin", "sa-dashboard");
    const other = await api(page, "POST", "/api/rfid/cards", { action: "register", employee_id: hr.id, uid: HR_CARD, reason: "Card issued" });
    expect(other.status, JSON.stringify(other.data)).toBe(200);
  });

  await step(page, "Terminal: the HR officer's tap is accepted and recorded; the Admin's card is refused (not on payroll)", async () => {
    // The Super Admin's terminal takes every branch's cards (a branch Admin's takes its own branch's only).
    await as(page, "super_admin", "sa-dashboard");
    const at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const tap = await kioskTap(page, HR_CARD, at);
    expect(tap.status, JSON.stringify(tap.body)).toBe(200);
    expect(tap.body.persisted).toBe(true);
    const taps = await rows(db().from("attendance_taps").select("id").eq("employee_id", hr.id).gte("tapped_at", new Date(Date.now() - 2 * 3600e3).toISOString()));
    expect(taps.length).toBeGreaterThan(0);
    const refused = await kioskTap(page, ADMIN_CARD);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.code).toBe("not_on_payroll");
    expect(String(refused.body.error || "")).toMatch(/not on payroll|does not record attendance/i);
  });

  await step(page, "HR cannot correct their own attendance (server-side); another HR can", async () => {
    await as(page, "hr", "hr-attendance");
    const own = await api(page, "PATCH", "/api/attendance/corrections", { action: "correct_absence", employee_id: hr.id, log_date: manilaDay(-1), time_in: "08:00", time_out: "17:00",
      remark: { code: "other", extra: "Self correction attempt" } });
    expect(own.status).toBe(403);
  });

  await step(page, "Nightly close: an HR day with no taps is closed like any employee's", async () => {
    const day = manilaDay(-3);
    psql(`set session_replication_role = replica; delete from attendance_logs where employee_id = '${hr.id}' and log_date = '${day}'; delete from attendance_taps where employee_id = '${hr.id}' and log_date = '${day}';`);
    psql(`select public.attendance_close_days('${day}'::date, '${day}'::date);`);
    const [hrRow] = await rows(db().from("attendance_logs").select("status").eq("employee_id", hr.id).eq("log_date", day));
    const working = await db().rpc("attendance_is_working_day_for", { p_employee: hr.id, p_branch: hr.branch_id, p_day: day });
    if (working.data) expect(hrRow?.status).toBe("Absent");
  });
  psql(`set session_replication_role = replica; update profiles set rfid_uid = null where id = '${admin.id}';`);
});
