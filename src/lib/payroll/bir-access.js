/**
 * Who reaches the BIR functions: the year-end tax annualization screen, BIR
 * Form 2316, the 1604-C alphalist and the generated BIR files. Server only.
 *
 * THE SUPER ADMIN ONLY (decision 2026-11-12): the BIR belongs to the school.
 * HR, Accountant, Employee and Admin are refused (403) at the proxy (module
 * "bir_forms", held by the Super Admin alone), again here by role, and again
 * in the database functions (20261112010000_bir_super_admin_only.sql).
 *
 * SCOPE: the Super Admin chooses a branch for the 2316s and the
 * annualization (birBranchScope); the 1604-C alphalist is the one place that
 * combines every branch (one school-wide filing under one TIN).
 *
 * Payroll processing does not come through here: a scheduled year-end
 * adjustment is read and applied by the payroll engine itself
 * (loadYearEndTaxContext in src/lib/payroll/bir-forms.js).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";

export const BIR_MODULE = "bir_forms";

const SUPER_ADMIN_ONLY = "Only the Super Admin handles the BIR forms and the year-end tax annualization.";

/** requirePermission() for the BIR functions, then the Super Admin role. */
export async function requireBirSuperAdmin(request, action = "read") {
  const guard = await requirePermission(request, BIR_MODULE, action);
  if (guard.denied) return guard;
  if (guard.role !== "super_admin") {
    return { ...guard, denied: NextResponse.json({ error: SUPER_ADMIN_ONLY, code: "super_admin_only" }, { status: 403 }) };
  }
  return guard;
}

/**
 * The branch a 2316 list or an annualization covers: the branch_id the Super
 * Admin chose (one of the school's branches), or the first branch by name. Returns
 * { branchId, branches } or { error } for an unknown branch.
 */
export async function birBranchScope(supabase, requested) {
  const value = String(requested ?? "").trim();
  if (value.length > 64) return { error: "Choose a branch from the list." };
  const result = await supabase.from("branches").select("id,name").order("name", { ascending: true });
  if (result.error) throw new Error(`Branches: ${result.error.message}`);
  const branches = (result.data || []).map((b) => ({ id: b.id, name: b.name }));
  if (value && !branches.some((b) => b.id === value)) return { error: "Choose a branch from the list." };
  return { branchId: value || branches[0]?.id || null, branches };
}

/** The alphalist covers every branch (null = no branch filter). */
export const ALPHALIST_SCOPE = null;

/**
 * The signed-in Super Admin, with what it may read, as the database decides
 * (payroll_bir_read_scope): guard.birScope = { role, branch_id: null, read_only: false }.
 * `supabase` is the service client.
 */
export async function requireBirReader(request, supabase) {
  const guard = await requireBirSuperAdmin(request, "read");
  if (guard.denied) return guard;
  const scope = await supabase.rpc("payroll_bir_read_scope", { p_actor: guard.userId });
  if (scope.error) {
    const failure = describeYearEndError(scope.error);
    return { ...guard, denied: NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status }) };
  }
  const row = Array.isArray(scope.data) ? scope.data[0] : scope.data;
  if (!row || row.role !== guard.role) {
    return { ...guard, denied: NextResponse.json({ error: SUPER_ADMIN_ONLY, code: "super_admin_only" }, { status: 403 }) };
  }
  return { ...guard, birScope: { role: row.role, branch_id: row.branch_id || null, read_only: row.read_only === true } };
}

const STATUS_BY_CODE = { forbidden: 403, invalid: 400, not_found: 404 };

/** A database function's refusal ("forbidden: ...") as { status, error, code }. */
export function describeYearEndError(error) {
  const message = String(error?.message || "").replace(/^ERROR:\s*/, "");
  const match = message.match(/^([a-z_]+):\s*(.*)$/s);
  if (match && STATUS_BY_CODE[match[1]]) {
    const text = match[2].charAt(0).toUpperCase() + match[2].slice(1);
    return { status: STATUS_BY_CODE[match[1]], error: text, code: match[1] };
  }
  if (/does not exist|schema cache|could not find the function/i.test(message)) {
    return { status: 503, error: "The year-end tax annualization is not set up yet: apply 20261029010000_tax_annualization.sql and 20261112010000_bir_super_admin_only.sql.", code: "not_ready" };
  }
  return { status: 500, error: "Not saved. Please try again.", code: "error" };
}
