// Service-role access to the LOCAL stack, for planting sign-in codes and for
// checking what the browser saved really reached the database.
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { ACCOUNTS, TEST_OTP, TEST_SESSION_SECRET } from "../accounts.mjs";
import { localSupabase } from "../local-env.mjs";

let client = null;
export function db() {
  if (!client) {
    const s = localSupabase();
    client = createClient(s.url, s.serviceKey, { auth: { persistSession: false } });
  }
  return client;
}

/** Rows or throw. */
export async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

/** Run SQL inside the local database container (fixtures only). */
export function psql(sql) {
  return execSync("docker exec -i supabase_db_SACS-PAYROLL psql -qtA -v ON_ERROR_STOP=1 -U postgres -d postgres", { input: sql, encoding: "utf8" }).trim();
}

export async function profileByEmail(email) {
  return rows(db().from("profiles").select("*").eq("email", email).single());
}

/** Store a known sign-in code exactly as src/lib/auth/email-otp.js does. */
export async function plantOtp(email, purpose = "login") {
  const { id } = await profileByEmail(email);
  const key = `${purpose}:${id}`;
  const hash = crypto.createHmac("sha256", TEST_SESSION_SECRET).update(`email-otp:${key}:${TEST_OTP}`).digest("base64url");
  await db().rpc("auth_email_otp_discard", { p_key: key });
  const issued = await db().rpc("auth_email_otp_issue", { p_key: key, p_hash: hash, p_ttl_seconds: 300, p_cooldown_seconds: 60, p_max_attempts: 5 });
  if (issued.error) throw new Error(`plant OTP: ${issued.error.message}`);
  return id;
}

/**
 * Archive an account a spec made for itself (profiles + account record, as
 * the archive routes do), so later specs see the seeded headcount again.
 * Quiet when the account does not exist.
 */
export async function archiveTestAccount(email) {
  const { data: profile } = await db().from("profiles").select("id,archived").eq("email", email).maybeSingle();
  if (!profile) return;
  const { data: user } = await db().auth.admin.getUserById(profile.id);
  if (user?.user) await db().auth.admin.updateUserById(profile.id, { user_metadata: { ...(user.user.user_metadata || {}), archived: true } });
  if (!profile.archived) await db().from("profiles").update({ archived: true, archived_at: new Date().toISOString() }).eq("id", profile.id);
}

/**
 * Take every account a spec made since `since` (ISO time) out of the way of
 * the specs after it: archived and off payroll (20261120020000), so it is in
 * no payroll run, attendance close or employee list. Seeded accounts are
 * older than any spec and are never touched.
 */
export async function retireAccountsCreatedSince(since) {
  if (!since) return 0;
  const seeded = new Set(Object.values(ACCOUNTS).map((a) => String(a.email).toLowerCase()));
  const made = (await rows(db().from("profiles").select("id,email").gte("created_at", since)))
    .filter((p) => !seeded.has(String(p.email || "").toLowerCase()));
  for (const { id } of made) {
    const { data: user } = await db().auth.admin.getUserById(id);
    if (user?.user) await db().auth.admin.updateUserById(id, { user_metadata: { ...(user.user.user_metadata || {}), archived: true, on_payroll: false } });
    await db().from("profiles").update({ archived: true, archived_at: new Date().toISOString(), on_payroll: false }).eq("id", id);
  }
  return made.length;
}

/**
 * Today is a working day for these employees, for a spec that taps or records
 * "today" (2026-11-21): when the suite runs on a weekend or a holiday, they
 * get an every-day work schedule from today and today's holiday is set aside.
 * The real date stays (the database keeps its own clock). Returns the undo;
 * on a working day nothing changes.
 */
export async function workingTodayFor(employeeIds) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const holidays = await rows(db().from("attendance_holidays").select("*").eq("holiday_date", today));
  if (weekday !== 0 && weekday !== 6 && !holidays.length) return async () => {};
  const key = crypto.randomUUID();
  psql(`set session_replication_role = replica;
    insert into work_schedules (schedule_key, name, work_start, work_end, grace_minutes, work_hours, working_days, effective_from, note, created_by_name)
      values ('${key}', 'E2E every day ${key.slice(0, 8)}', '08:00', '17:00', 15, 8, '{1,2,3,4,5,6,7}', '2026-01-01', 'E2E: today is a working day', 'E2E');
    ${employeeIds.map((id) => `insert into work_schedule_assignments (employee_id, schedule_key, effective_from, note, created_by_name) values ('${id}', '${key}', '${today}', 'E2E', 'E2E');`).join("\n    ")}
    delete from attendance_holidays where holiday_date = '${today}';`);
  return async () => {
    psql(`set session_replication_role = replica;
      delete from work_schedule_assignments where schedule_key = '${key}';
      delete from work_schedules where schedule_key = '${key}';`);
    if (holidays.length) await db().from("attendance_holidays").insert(holidays);
  };
}
