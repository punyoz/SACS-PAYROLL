/**
 * Super Admin → System Configuration → General → Organization name.
 *
 * Saved to system_config (section "general", key "org_name") but read by
 * nothing until 2026-10-21. It is the short name the system goes by: the
 * "<name> Payroll" in the portal header, on payslips ("Payslip - <name>
 * Payroll Management System") and in the sign-in / password code emails
 * (subject, sender name, footer). The school's full legal name on payslips
 * and the payroll sheet is not this setting (the sheet has its own,
 * sheet_school_name).
 *
 * Live holds "SACS", so with no change everything reads as before.
 * Formatting lives in src/lib/org-name-format.js (safe for the browser).
 */

import { getCachedServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_ORG_NAME, normalizeOrgName } from "@/lib/org-name-format";

export { DEFAULT_ORG_NAME, ORG_NAME_MAX, normalizeOrgName, systemName } from "@/lib/org-name-format";

export const ORG_NAME_SECTION = "general";
export const ORG_NAME_KEY = "org_name";

const CACHE_TTL_MS = 60_000;
let cached = null; // { name, at }

/**
 * The saved name, cached for a minute. Never throws: any failure answers
 * the default, so a sign-in email or payslip is never held up by it.
 * @param {object} [supabase] a service-role client; one is created when omitted.
 */
export async function loadOrgName(supabase) {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.name;
  try {
    const db = supabase || getAdminClient();
    if (!db) return DEFAULT_ORG_NAME;
    const result = await db.from("system_config").select("value")
      .eq("section", ORG_NAME_SECTION).eq("key", ORG_NAME_KEY).maybeSingle();
    if (result.error) throw result.error;
    const name = normalizeOrgName(result.data?.value);
    cached = { name, at: Date.now() };
    return name;
  } catch {
    return DEFAULT_ORG_NAME;
  }
}

/** Forget the cached name (after the Super Admin saves General settings). */
export function invalidateOrgName() {
  cached = null;
}
