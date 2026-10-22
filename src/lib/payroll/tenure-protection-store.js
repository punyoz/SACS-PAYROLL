/**
 * Reads the Tenure Pay Protection tables (20261015010000_tenure_pay_protection.sql)
 * for payroll and the HR screen. Server only: the tables are closed to the
 * client roles, so these run with the service-role client.
 */

import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";

export const TENURE_NOT_READY = "Tenure Pay Protection is not set up yet: apply supabase/migrations/20261015010000_tenure_pay_protection.sql.";

export function isMissingTable(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("42703") || text.includes("pgrst205") || text.includes("does not exist")
    || text.includes("could not find") || text.includes("schema cache");
}

/**
 * Policies, grants (optionally only these employees') and break periods.
 * `available` is false while the migration is not applied: payroll then
 * runs exactly as before, with no protection.
 */
export async function loadTenureProtection(supabase, { employeeIds = null } = {}) {
  const [policies, grants, breaks] = await Promise.all([
    fetchAllRows(() => supabase.from("tenure_protection_policies").select("*").order("id", { ascending: true })),
    Array.isArray(employeeIds)
      ? fetchAllIn(() => supabase.from("tenure_protection_grants").select("*").order("granted_at", { ascending: false }).order("id", { ascending: true }), "employee_id", employeeIds)
        .then((r) => ({ ...r, data: (r.data || []).sort((a, b) => String(b.granted_at || "").localeCompare(String(a.granted_at || ""))) }))
      : fetchAllRows(() => supabase.from("tenure_protection_grants").select("*").order("granted_at", { ascending: false }).order("id", { ascending: true })),
    fetchAllRows(() => supabase.from("school_break_periods").select("*").order("start_date", { ascending: true }).order("id", { ascending: true })),
  ]);
  const error = policies.error || grants.error || breaks.error;
  if (error) {
    if (isMissingTable(error)) return { available: false, policies: [], grants: [], breaks: [] };
    throw new Error(error.message);
  }
  return { available: true, policies: policies.data || [], grants: grants.data || [], breaks: breaks.data || [] };
}
