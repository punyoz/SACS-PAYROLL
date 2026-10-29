/**
 * Who reaches the year-end BIR functions (2026-10-29): the year-end tax
 * annualization, BIR Form 2316 and the 1604-C alphalist. Server only.
 *
 * GENERATE / CHANGE (requireBirAccountant): the Accountant only — running and
 * scheduling the annualization, generating 2316s and the alphalist. HR, Admin
 * and Super Admin are refused (403) at the proxy (/api/payroll/bir-forms is
 * mapped to "payroll_reports", which only the Accountant holds) and again here
 * by role, so a later change to the matrix cannot open these by accident.
 *
 * READ (requireBirReader, decision 2026-10-29): the Accountant (its branch)
 * and, read-only for oversight, the Super Admin (every branch): the
 * annualization records and the BIR files already generated. The database
 * answers who reads what (payroll_bir_read_scope, 20261029010000).
 *
 * SCOPE (decision 2026-10-29): the annualization and the 2316 stay on the
 * Accountant's own branch, like processing payroll; the 1604-C alphalist is
 * one school-wide filing under one TIN, so any Accountant generates it from
 * every branch's approved payroll — a read for that export only, never an
 * edit (birBranchScope / ALPHALIST_SCOPE; payroll_bir_export_save checks the
 * 2316's branch again). An employee downloads only their own 2316
 * (/api/employee/bir-2316).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/guard";

export const BIR_MODULE = "payroll_reports";

const ACCOUNTANT_ONLY = "Only the Accountant can use the year-end tax annualization, BIR Form 2316 and the alphalist.";

/** requirePermission() for the BIR functions, then the Accountant role and a branch. */
export async function requireBirAccountant(request, action = "read") {
  const guard = await requirePermission(request, BIR_MODULE, action);
  if (guard.denied) return guard;
  if (guard.role !== "accountant") {
    return { ...guard, denied: NextResponse.json({ error: ACCOUNTANT_ONLY, code: "accountant_only" }, { status: 403 }) };
  }
  if (!guard.branchId) {
    return { ...guard, denied: NextResponse.json({ error: "Your account has no branch.", code: "no_branch" }, { status: 403 }) };
  }
  return guard;
}

/** The branch the Accountant's annualization and 2316 cover (see SCOPE above). */
export function birBranchScope(guard) {
  return guard.branchId;
}

/** The alphalist covers every branch (null = no branch filter). */
export const ALPHALIST_SCOPE = null;

const READERS_ONLY = "Only the Accountant and (read-only) the Super Admin see the year-end tax records.";

/**
 * A signed-in Accountant or Super Admin, with what it may read:
 * guard.birScope = { role, branch_id (null = every branch), read_only }.
 * The database decides (payroll_bir_read_scope); `supabase` is the service client.
 */
export async function requireBirReader(request, supabase) {
  // Every role holds "profile" (its own): this only checks the session.
  const guard = await requirePermission(request, "profile", "read");
  if (guard.denied) return guard;
  if (!["accountant", "super_admin"].includes(guard.role)) {
    return { ...guard, denied: NextResponse.json({ error: READERS_ONLY, code: "not_a_reader" }, { status: 403 }) };
  }
  const scope = await supabase.rpc("payroll_bir_read_scope", { p_actor: guard.userId });
  if (scope.error) {
    const failure = describeYearEndError(scope.error);
    return { ...guard, denied: NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status }) };
  }
  const row = Array.isArray(scope.data) ? scope.data[0] : scope.data;
  if (!row || row.role !== guard.role) {
    return { ...guard, denied: NextResponse.json({ error: READERS_ONLY, code: "not_a_reader" }, { status: 403 }) };
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
    return { status: 503, error: "The year-end tax annualization is not set up yet: apply 20261029010000_tax_annualization.sql.", code: "not_ready" };
  }
  return { status: 500, error: "Not saved. Please try again.", code: "error" };
}
