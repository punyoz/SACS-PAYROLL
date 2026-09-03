/**
 * Route guard — the single place every API route asks "may this caller do
 * this?".
 *
 * Each guarded handler starts with one call:
 *
 *   const guard = await requirePermission(request, "user_management", "create");
 *   if (guard.denied) return guard.denied;      // 401 / 403 NextResponse
 *
 * and then uses `guard.branchId` to scope its queries. The guard answers both
 * halves of the rule at once:
 *
 *   (a) does the caller's role permit this action on this module?
 *   (b) if the role is branch-scoped, which branch_id is it pinned to?
 *
 * The API routes hold the Supabase service-role key, which bypasses Row Level
 * Security entirely — so RLS alone can never protect them. This guard is the
 * layer that actually enforces the matrix on those routes; the RLS policies in
 * supabase/migrations/20260903_rbac_branch_scoping.sql are the second layer,
 * covering any client that talks to Postgres directly with a user JWT.
 */

import { NextResponse } from "next/server";
import { readSession } from "@/lib/rbac/session";
import {
  can,
  canManageRole,
  isBranchExempt,
  isBranchScoped,
  isKnownRole,
  scopeFor,
  SCOPE_NONE,
} from "@/lib/rbac/permissions";

function deny(message, status) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Resolve and authorize the caller.
 *
 * @param {Request} request
 * @param {string} module  key in MODULES (e.g. "user_management")
 * @param {string} action  "create" | "read" | "update" | "delete"
 * @returns {Promise<{
 *   denied: import("next/server").NextResponse | null,
 *   session: object | null,
 *   role: string,
 *   userId: string,
 *   branchId: string | null,
 *   scope: string,
 *   branchExempt: boolean,
 * }>}
 */
export async function requirePermission(request, module, action = "read") {
  const session = readSession(request);

  if (!session) {
    return {
      denied: deny("Your session has expired. Please sign in again.", 401),
      session: null, role: "", userId: "", branchId: null,
      scope: SCOPE_NONE, branchExempt: false,
    };
  }

  const role = String(session.role || "").toLowerCase();

  if (!isKnownRole(role)) {
    return {
      denied: deny("Your account has no valid role assigned.", 403),
      session, role, userId: session.sub, branchId: null,
      scope: SCOPE_NONE, branchExempt: false,
    };
  }

  if (!can(role, module, action)) {
    return {
      denied: deny("You do not have permission to perform this action.", 403),
      session, role, userId: session.sub, branchId: session.branch_id || null,
      scope: SCOPE_NONE, branchExempt: false,
    };
  }

  const branchExempt = isBranchExempt(role);
  const branchId = branchExempt ? null : (session.branch_id || null);

  // A branch-scoped role with no branch on file cannot be safely scoped:
  // letting the query through unfiltered would expose every branch.
  if (!branchExempt && isBranchScoped(role) && !branchId) {
    return {
      denied: deny(
        "Your account is not assigned to a branch yet. Ask a Super Admin to assign one.",
        403,
      ),
      session, role, userId: session.sub, branchId: null,
      scope: SCOPE_NONE, branchExempt: false,
    };
  }

  return {
    denied: null,
    session,
    role,
    userId: String(session.sub || ""),
    branchId,
    scope: scopeFor(role, module),
    branchExempt,
  };
}

/**
 * Reject a branch-scoped caller reaching at another branch's row.
 * Returns a NextResponse to send back, or null when access is fine.
 */
export function denyForeignBranch(guard, targetBranchId) {
  if (guard.branchExempt) return null;

  const target = targetBranchId ? String(targetBranchId) : "";
  if (!target) return null;

  if (target !== String(guard.branchId || "")) {
    return deny("That record belongs to another branch.", 403);
  }
  return null;
}

/**
 * Reject an attempt to create, edit, archive, or elevate an account whose role
 * sits at or above the caller's ceiling — e.g. an Admin touching an admin or
 * super_admin account. Returns a NextResponse, or null when allowed.
 */
export function denyRoleEscalation(guard, targetRole) {
  const target = String(targetRole || "").toLowerCase();
  if (!target) return null;

  if (!canManageRole(guard.role, target)) {
    return deny(
      `You are not allowed to manage ${target.replace("_", " ")} accounts.`,
      403,
    );
  }
  return null;
}

/**
 * Apply the caller's branch filter to a Supabase query builder.
 * Super Admin passes through untouched; everyone else gets .eq(column, branch).
 */
export function scopeQueryToBranch(query, guard, column = "branch_id") {
  if (guard.branchExempt) return query;
  return query.eq(column, guard.branchId);
}

/**
 * Filter an in-memory array down to the caller's branch. Used by the routes
 * that read users out of Supabase Auth (where user_metadata.branch_id lives)
 * rather than from a table.
 */
export function scopeListToBranch(rows, guard, pick = (row) => row?.branch_id) {
  if (guard.branchExempt) return rows;
  return (rows || []).filter((row) => String(pick(row) || "") === String(guard.branchId || ""));
}
