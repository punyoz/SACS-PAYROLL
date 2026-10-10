/**
 * The people payroll pays (Employee and Accountant accounts, not archived),
 * scoped like the payroll route's fetchEmployees(): a branch-scoped caller
 * sees its own branch only; SCOPE_SELF sees only itself. Used by the loans,
 * AWOL, approvals and final-pay routes (a route file may only export its
 * HTTP handlers, so the payroll route keeps its own copy).
 *
 * Each person carries the profile facts those routes need: branch, type,
 * employee status, payroll hold, separation date, date hired and whether
 * they are a licensed teacher.
 */

import { normalizeText } from "@/lib/auth/normalize";
import { listUsersCached } from "@/lib/auth/users-cache";
import { SCOPE_SELF } from "@/lib/rbac/permissions";

const PAID_ROLES = new Set(["employee", "accountant"]);

function isMissingColumn(error) {
  const text = String(error?.message || "").toLowerCase();
  return text.includes("column") || text.includes("does not exist") || text.includes("schema cache");
}

/**
 * @param {object} supabase  service-role client
 * @param {object} guard     requirePermission() result
 * @param {{ includeArchived?: boolean }} [options]
 */
export async function loadPayrollStaff(supabase, guard, { includeArchived = false } = {}) {
  const usersResult = await listUsersCached(supabase);
  if (usersResult.error) throw new Error(`Failed to list users: ${usersResult.error.message}`);

  const users = (usersResult.data?.users || []).filter((user) => PAID_ROLES.has(String(user.user_metadata?.role || "employee").toLowerCase()));
  const ids = users.map((user) => user.id);
  const profiles = new Map();
  if (ids.length) {
    const base = "id,full_name,email,branch_id,position,employee_type,employee_status,archived,date_hired";
    let result = await supabase.from("profiles")
      .select(`${base},payroll_hold,payroll_hold_reason,separated_on,separation_reason,is_licensed_teacher`)
      .in("id", ids);
    // Before 20261009010000 the payroll-hold / license columns do not exist.
    if (result.error && isMissingColumn(result.error)) result = await supabase.from("profiles").select(base).in("id", ids);
    if (result.error) throw new Error(`Failed to fetch profiles: ${result.error.message}`);
    (result.data || []).forEach((row) => profiles.set(row.id, row));
  }

  return users
    .map((user, index) => {
      const profile = profiles.get(user.id) || {};
      const metadata = user.user_metadata || {};
      return {
        id: user.id,
        role: String(metadata.role || "employee").toLowerCase(),
        full_name: normalizeText(profile.full_name, normalizeText(metadata.full_name, user.email)),
        email: normalizeText(profile.email, user.email),
        employee_id: normalizeText(metadata.employee_id, `SACS-${String(index + 1).padStart(3, "0")}`),
        employee_type: normalizeText(profile.employee_type, normalizeText(metadata.employee_type, "Teaching")),
        position: normalizeText(metadata.position, normalizeText(profile.position)),
        branch_id: profile.branch_id || metadata.branch_id || null,
        employee_status: normalizeText(profile.employee_status, "Active"),
        archived: Boolean(profile.archived ?? metadata.archived),
        date_hired: profile.date_hired || null,
        payroll_hold: Boolean(profile.payroll_hold),
        payroll_hold_reason: profile.payroll_hold_reason || null,
        separated_on: profile.separated_on || null,
        separation_reason: profile.separation_reason || null,
        is_licensed_teacher: Boolean(profile.is_licensed_teacher),
      };
    })
    .filter((person) => includeArchived || !person.archived)
    .filter((person) => {
      if (!guard || guard.branchExempt) return true;
      if (guard.scope === SCOPE_SELF) return person.id === guard.userId;
      return String(person.branch_id || "") === String(guard.branchId || "");
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** "Name (code)" for messages. */
export function personLabel(person) {
  return person ? `${person.full_name}${person.employee_id ? ` (${person.employee_id})` : ""}` : "this employee";
}

/** The actor's display name for created_by_name / changed_by_name columns. */
export function actorName(guard) {
  return normalizeText(guard?.session?.full_name, guard?.session?.email) || null;
}
