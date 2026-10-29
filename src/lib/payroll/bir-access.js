/**
 * Who reaches the year-end BIR functions (2026-10-29): the year-end tax
 * annualization, BIR Form 2316 and the 1604-C alphalist. Server only.
 *
 * The Accountant only. HR, Admin and Super Admin are refused (403) at the
 * proxy (src/proxy.js maps both routes to "payroll_reports", which only the
 * Accountant holds) and again here by role, so a later change to the matrix
 * cannot open these to another role by accident. An employee downloads only
 * their own 2316 (/api/employee/bir-2316).
 *
 * SCOPE: the Accountant's own branch (its current branch), the same rule as
 * processing payroll. Whether the employer-level filings (the alphalist, the
 * 2316 of every branch) should instead be school-wide for the Accountant is an
 * open decision for the school; until it is made, birBranchScope() is the one
 * place that answers it, and the database functions of 20261029010000 check
 * the branch again.
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

/** The branch the Accountant's year-end functions cover (see SCOPE above). */
export function birBranchScope(guard) {
  return guard.branchId;
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
