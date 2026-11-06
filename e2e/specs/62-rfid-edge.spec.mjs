// RFID, the cases 60-rfid-flow does not cover, on a new employee made here
// (Eli, Main Campus) so no seeded person is touched:
//  time in late (a kiosk tap saved offline earlier today) → time out now →
//  late and undertime computed from his shift; the record shows in HR
//  Attendance, the Accountant's View Attendance and the timesheet; a missed
//  day is Absent; the nightly close marks an untapped day Absent; a tap on a
//  holiday and on a rest day (the server's date moved: E2E_TIME_TRAVEL=1);
//  his card after he is deactivated is refused.
import { test, expect } from "../support/test.mjs";
import { as } from "../support/auth.mjs";
import { step } from "../support/banner.mjs";
import { main, settle } from "../support/portal.mjs";
import { api, manilaDay } from "../support/flow.mjs";
import { archiveTestAccount, db, profileByEmail, psql, rows } from "../support/db.mjs";
import { TIME_TRAVEL, travelTo, travelHome } from "../support/time-travel.mjs";
import { ACCOUNTS, BRANCH_MAIN } from "../accounts.mjs";

const stamp = Date.now().toString(36).slice(-5);
const Tag = stamp.replace(/\d/g, (d) => "abcdefghij"[d]);
const ELI = { email: `eli.${stamp}@e2e.test`, first: "Eli", last: `Santos${Tag.charAt(0).toUpperCase()}${Tag.slice(1)}` };
const CARD = `77${String(Date.now()).slice(-8)}`;

function body(branchId) {
  return {
    first_name: ELI.first, last_name: ELI.last, email: ELI.email, role: "employee", branch_id: branchId, password: "Eli-Temp#2026",
    employee_type: "Non-Teaching", position: "Utility Staff", employment_type: "Full-time", employment_status: "Probationary",
    employee_status: "Active", date_hired: "2026-06-01", basic_salary: 20880, date_of_birth: "1993-03-03", sex: "Male",
    civil_status: "Single", address: "8 Luna St, Pasig City", cp_number: `0918${String(Date.now()).slice(-7)}`, sss_number: "1234567890",
    philhealth_number: "123456789012", pagibig_number: "123456789012", tin_number: "123456789", emergency_contact_name: "Lina Santos",
    emergency_contact_relationship: "Parent", emergency_contact_address: "8 Luna St, Pasig City", emergency_contact_number: "09181234567",
  };
}

/** "7:30 AM" → minutes after midnight. */
function minutesOf(label) {
  const m = String(label || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}
const manilaMinutesNow = () => {
  const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour12: false }).split(":").map(Number);
  return h * 60 + m;
};

// Eli leaves Main Campus's headcount as seeded for later specs, even on a failure.
test.afterAll(async () => { await travelHome(); await archiveTestAccount(ELI.email); });

async function kioskTap(page, uid, offlineAt) {
  return page.evaluate(async ({ uid, offlineAt }) => {
    const res = await fetch("/api/admin/attendance", { method: "POST", headers: { "Content-Type": "application/json", "x-sacs-kiosk": "1" }, body: JSON.stringify({ device: "RFID Terminal · E2E", rfid_code: uid, ...(offlineAt ? { offline_tapped_at: offlineAt } : {}) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, { uid, offlineAt });
}

test("RFID edge cases: late time in, time out, where taps show, absence, nightly close, holiday / rest day, deactivated employee", async ({ page, monitor }) => {
  test.setTimeout(20 * 60 * 1000);
  monitor.allow(/^4\d\d POST \/api\/admin\/attendance/, /status of 4/);
  const today = manilaDay(0);
  const mainId = (await rows(db().from("branches").select("id").eq("name", BRANCH_MAIN).single())).id;
  let eli;
  let shift = { in: null, out: null };

  await step(page, "HR > adds employee Eli (Main Campus) and registers his card", async () => {
    monitor.at("HR > User Management + RFID Cards");
    await as(page, "hr", "hr-rfid-cards");
    const made = await api(page, "POST", "/api/admin/employees", body(mainId));
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    eli = await profileByEmail(ELI.email);
    const card = await api(page, "POST", "/api/rfid/cards", { action: "register", employee_id: eli.id, uid: CARD, reason: "E2E new card" });
    expect([200, 201], JSON.stringify(card.data)).toContain(card.status);
    const ts = await api(page, "GET", `/api/employee/timesheet?email=${encodeURIComponent(ELI.email)}&start_date=${today}&end_date=${today}`);
    const day = (ts.data.records || []).find((r) => r.date === today) || {};
    shift = { in: minutesOf(day.shift_in), out: minutesOf(day.shift_out), label: `${day.shift_in} - ${day.shift_out}`, required: day.required_hours };
    console.log(`  · Eli's shift today: ${shift.label} (${shift.required} h required)`);
  });

  await step(page, "HR > RFID Terminal > unlock with HR's password", async () => {
    monitor.at("RFID Terminal");
    await main(page).getByRole("button", { name: "Open RFID Terminal" }).click().catch(async () => { await as(page, "hr", "hr-rfid-terminals"); await main(page).getByRole("button", { name: "Open RFID Terminal" }).click(); });
    await page.waitForURL(/rfid-terminal/);
    await page.locator("#rt-lock-password").fill(ACCOUNTS.hr.password);
    await page.getByRole("button", { name: "Unlock terminal" }).click();
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
  });

  const lateBy = 20;
  await step(page, `Kiosk > Eli's tap saved offline at shift start + ${lateBy} min (time in, late)`, async () => {
    expect(shift.in, "the timesheet gives Eli a shift").not.toBeNull();
    // Early in the morning the tap can only be 10 minutes ago.
    const at = Math.min(shift.in + lateBy, manilaMinutesNow() - 10);
    const expectedLate = Math.max(0, at - shift.in);
    const hh = String(Math.floor(at / 60)).padStart(2, "0");
    const mm = String(at % 60).padStart(2, "0");
    const res = await kioskTap(page, CARD, `${today}T${hh}:${mm}:00+08:00`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tap).toBe("time_in");
    const log = await rows(db().from("attendance_logs").select("status,late_minutes,time_in").eq("employee_id", eli.id).eq("log_date", today).single());
    expect(log.late_minutes, "late minutes = tap - shift start").toBe(expectedLate);
  });

  await step(page, "Kiosk > Eli taps again now (time out): undertime = shift end - now, when before the shift ends", async () => {
    const res = await page.evaluate(async (uid) => {
      const r = await fetch("/api/admin/attendance", { method: "POST", headers: { "Content-Type": "application/json", "x-sacs-kiosk": "1" }, body: JSON.stringify({ device: "RFID Terminal · E2E", rfid_code: uid }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tap).toBe("time_out");
    const out = manilaMinutesNow();
    const log = await rows(db().from("attendance_logs").select("status,late_minutes,undertime_minutes,time_in,time_out").eq("employee_id", eli.id).eq("log_date", today).single());
    console.log(`  · Eli today: ${JSON.stringify(log)}`);
    expect(log.time_out).toBeTruthy();
    // Worked under half the required hours: a Half Day, which replaces late
    // and undertime (status engine, 20261013010000); deducted once as a half day.
    const inAt = Math.min(shift.in + lateBy, out - 10);
    if ((out - inAt) / 60 < Number(shift.required || 8) / 2) {
      expect(log.status).toBe("Half Day");
      expect(Number(log.undertime_minutes || 0) + Number(log.late_minutes || 0)).toBe(0);
    } else if (out < shift.out) {
      const expected = shift.out - out;
      expect(Math.abs(Number(log.undertime_minutes) - expected), `undertime ${log.undertime_minutes} vs ${expected} expected`).toBeLessThanOrEqual(2);
      expect(String(log.status)).toMatch(/Undertime|Half Day|Late/i);
    } else {
      expect(Number(log.undertime_minutes || 0)).toBe(0);
    }
  });

  await step(page, "Kiosk > the same card a moment later is a repeat, not a third record", async () => {
    const res = await kioskTap(page, CARD);
    expect(res.status).toBe(200);
    expect(res.body.tap).toBe("duplicate");
  });

  await step(page, "HR > Attendance lists Eli today; yesterday (no tap) is Absent", async () => {
    monitor.at("HR > Attendance");
    await as(page, "hr", "hr-attendance");
    await settle(page);
    // The list is paginated: search for him.
    await main(page).getByPlaceholder(/Search/i).first().fill(ELI.last);
    await settle(page);
    await expect(main(page).getByText(new RegExp(`Eli ${ELI.last}`, "i")).first()).toBeVisible({ timeout: 30000 });
    const yesterday = manilaDay(-1);
    const dow = new Date(`${yesterday}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      // The nightly close makes yesterday's missing tap an absence; run it as cron would.
      psql(`SELECT public.attendance_close_days('${yesterday}'::date, '${yesterday}'::date);`);
      const y = await rows(db().from("attendance_logs").select("status").eq("employee_id", eli.id).eq("log_date", yesterday));
      expect(y[0]?.status, "a weekday with no tap is Absent after the nightly close").toBe("Absent");
    }
  });

  await step(page, "Accountant > View Attendance lists Eli (read-only)", async () => {
    monitor.at("Accountant > View Attendance");
    await as(page, "accountant", "ac-attendance");
    await settle(page);
    const search = main(page).getByPlaceholder(/Search/i).first();
    if (await search.isVisible().catch(() => false)) { await search.fill(ELI.last); await settle(page); }
    await expect(main(page).getByText(new RegExp(`Eli ${ELI.last}`, "i")).first()).toBeVisible({ timeout: 30000 });
    for (const name of ["Edit", "Correct", "Delete", "Save"]) await expect(main(page).getByRole("button", { name, exact: true })).toHaveCount(0);
  });

  await step(page, "Timesheet (Eli's) shows today's time in and time out", async () => {
    await as(page, "hr");
    const ts = await api(page, "GET", `/api/employee/timesheet?email=${encodeURIComponent(ELI.email)}&start_date=${today}&end_date=${today}`);
    const day = (ts.data.records || []).find((r) => r.date === today);
    expect(day?.time_in, JSON.stringify(day)).toBeTruthy();
    expect(day?.time_out).toBeTruthy();
  });

  for (const [date, what] of [["2026-11-30", "a regular holiday (Bonifacio Day, Monday)"], ["2026-11-08", "a rest day (Sunday)"]]) {
    await step(page, `Kiosk > Eli taps on ${date}, ${what}`, async () => {
      if (!TIME_TRAVEL) { console.log("  · NOT RUN: needs E2E_TIME_TRAVEL=1 (the server's date must move)"); return; }
      monitor.at(`RFID Terminal (${date})`);
      await as(page, "hr", "hr-rfid-terminals");
      await travelTo(date, page);
      await page.goto("/rfid-terminal");
      if (await page.locator("#rt-lock-password").isVisible().catch(() => false)) {
        await page.locator("#rt-lock-password").fill(ACCOUNTS.hr.password);
        await page.getByRole("button", { name: "Unlock terminal" }).click();
      }
      await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
      const res = await kioskTap(page, CARD);
      const log = await rows(db().from("attendance_logs").select("status,time_in,late_minutes").eq("employee_id", eli.id).eq("log_date", date));
      const review = await rows(db().from("holiday_work_reviews").select("status").eq("employee_id", eli.id)).catch(() => []);
      console.log(`  · ${date}: tap answered ${res.status} ${res.body.tap || res.body.code || ""}; log ${JSON.stringify(log)}; holiday-work reviews ${JSON.stringify(review)}`);
      await travelHome(page);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      if (res.status === 200) {
        expect(log, "the tap is recorded on that day").toHaveLength(1);
        expect(String(log[0].status)).not.toBe("Absent");
        expect(Number(log[0].late_minutes || 0), "no lateness is charged on a day off").toBe(0);
      }
      const ts = await api(page, "GET", `/api/employee/timesheet?email=${encodeURIComponent(ELI.email)}&start_date=${date}&end_date=${date}`);
      const day = (ts.data.records || []).find((r) => r.date === date);
      expect(day?.required_hours, `${date} requires 0 hours`).toBe(0);
    });
  }

  await step(page, "HR > deactivates (archives) Eli; his card at the kiosk is refused", async () => {
    monitor.at("HR > archive + kiosk");
    await travelHome(page);
    await as(page, "hr", "hr-employees");
    const arch = await api(page, "PATCH", "/api/admin/employees", { id: eli.id, action: "archive", reason: "E2E deactivated" });
    expect([200, 201], JSON.stringify(arch.data)).toContain(arch.status);
    await as(page, "hr", "hr-rfid-terminals");
    await page.goto("/rfid-terminal");
    if (await page.locator("#rt-lock-password").isVisible().catch(() => false)) {
      await page.locator("#rt-lock-password").fill(ACCOUNTS.hr.password);
      await page.getByRole("button", { name: "Unlock terminal" }).click();
    }
    await page.locator("#rt-scan-input").waitFor({ timeout: 30000 });
    const response = page.waitForResponse((r) => r.url().includes("/api/admin/attendance") && r.request().method() === "POST");
    await page.locator("#rt-scan-input").click();
    await page.keyboard.type(CARD, { delay: 20 });
    await page.keyboard.press("Enter");
    const res = await response;
    const b = await res.json().catch(() => ({}));
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(["employee_inactive", "card_inactive"]).toContain(b.code);
    await expect(page.getByText(/inactive|not active|see HR/i).first()).toBeVisible();
  });
});
