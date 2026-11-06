// Service-role access to the LOCAL stack, for planting sign-in codes and for
// checking what the browser saved really reached the database.
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { TEST_OTP, TEST_SESSION_SECRET } from "../accounts.mjs";
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
