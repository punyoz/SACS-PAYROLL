import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch, denyRoleEscalation } from "@/lib/rbac/guard";
import { can } from "@/lib/rbac/permissions";
import { invalidateUsersCache, getTrustedUserById } from "@/lib/auth/users-cache";
import { revokeActiveSession } from "@/lib/auth/active-session";
import {
  readAllTransferRequests,
  insertTransferRequest,
  updateTransferRequestStatus,
  getEmployeeCurrentBranch,
} from "@/lib/transfer-requests/store";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Put the employee in the destination branch. The approval trigger on
 * transfer_requests already does this; writing it here as well keeps the move
 * correct on a database where that trigger is missing, and keeps the auth
 * metadata copy (still read as a fallback by older code paths) in step.
 *
 * The UPDATE is conditioned on the employee still being in `fromBranchId` —
 * the branch this transfer was raised against. Without that, two concurrent
 * transfer requests for the same employee (to two different destinations)
 * could both apply: both transfer_requests rows would end up marked
 * "approved", but the employee only actually lands in whichever one's UPDATE
 * ran last, leaving a contradictory audit trail. Returns `moved: false` when
 * the condition didn't match, so the caller can tell the race happened.
 */
async function applyBranchMove(supabase, employeeId, fromBranchId, toBranchId) {
  let query = supabase
    .from("profiles")
    .update({ branch_id: toBranchId, updated_at: new Date().toISOString() })
    .eq("id", employeeId);
  query = fromBranchId ? query.eq("branch_id", fromBranchId) : query.is("branch_id", null);

  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) return { moved: false };

  const { data: userData } = await getTrustedUserById(supabase, employeeId);
  if (userData?.user) {
    await supabase.auth.admin.updateUserById(employeeId, {
      user_metadata: { ...(userData.user.user_metadata || {}), branch_id: toBranchId },
    });
    invalidateUsersCache();
  }
  // The session cookie still carries the old branch; end it so the next
  // sign-in picks up the new one.
  await revokeActiveSession(employeeId);
  return { moved: true };
}

export async function GET(request) {
  const guard = await requirePermission(request, "transfer_requests", "read");
  if (guard.denied) return guard.denied;

  try {
    const allRequests = await readAllTransferRequests();

    // Super Admin sees every request. Admin sees requests out of its own
    // branch, plus any it raised itself even when from_branch_id is null
    // (assigning a previously-unassigned employee) — scopeListToBranch alone
    // would drop those since null never equals a branch id.
    const scoped = guard.branchExempt
      ? allRequests
      : allRequests.filter(
          (r) => String(r.from_branch_id || "") === String(guard.branchId || "")
            || r.requested_by === guard.userId,
        );

    const pending = scoped.filter((r) => r.status === "pending");
    const history = scoped.filter((r) => r.status !== "pending");

    return NextResponse.json({
      requests: scoped,
      pending_requests: pending,
      history_requests: history,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "transfer_requests", "create");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const employeeId = normalizeText(body.employee_id);
    const toBranchId = normalizeText(body.to_branch_id);
    const remarks = normalizeText(body.remarks);

    if (!employeeId || !toBranchId) {
      return NextResponse.json(
        { error: "employee_id and to_branch_id are required." },
        { status: 400 },
      );
    }

    const supabase = getAdminClient();

    const { data: employeeData, error: employeeError } = await getTrustedUserById(supabase, employeeId);
    if (employeeError || !employeeData?.user) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }
    const employeeMeta = employeeData.user.user_metadata || {};
    if (employeeMeta.archived === true) {
      return NextResponse.json({ error: "Archived employees cannot be transferred." }, { status: 400 });
    }
    // Only accounts the caller manages can be moved (HR: Employee/Accountant).
    const escalation = denyRoleEscalation(guard, normalizeText(employeeMeta.role, "employee"));
    if (escalation) return escalation;

    const { data: destination, error: destinationError } = await supabase
      .from("branches")
      .select("id,name,status")
      .eq("id", toBranchId)
      .maybeSingle();
    if (destinationError || !destination) {
      return NextResponse.json({ error: "Destination branch not found." }, { status: 404 });
    }
    if (String(destination.status || "Active").toLowerCase() !== "active") {
      return NextResponse.json({ error: "Destination branch is inactive." }, { status: 400 });
    }

    // from_branch_id is the employee's ACTUAL current branch, not whatever
    // the caller claims — looked up server-side so it's correct whether the
    // employee already belongs to a branch or has never been assigned one
    // (null). A branch-scoped caller may only touch its own branch's staff.
    const fromBranchId = await getEmployeeCurrentBranch(employeeId);

    const foreignBranch = denyForeignBranch(guard, fromBranchId);
    if (foreignBranch) return foreignBranch;

    if (fromBranchId === toBranchId) {
      return NextResponse.json(
        { error: "Destination branch must be different from the current branch." },
        { status: 400 },
      );
    }

    const existingPending = (await readAllTransferRequests()).find(
      (r) => r.employee_id === employeeId && r.status === "pending",
    );
    if (existingPending) {
      return NextResponse.json(
        { error: "This employee already has a pending transfer request. Decide that one first." },
        { status: 409 },
      );
    }

    let request_ = await insertTransferRequest({
      employee_id: employeeId,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId,
      // Identity comes from the signed session cookie, never the body — the
      // caller cannot submit a request as someone else.
      requested_by: guard.userId,
      remarks,
    });

    // A caller who may also decide transfers (HR) has nobody above it to wait
    // for: the move is approved and applied at once, and stays on record in
    // Transfer History.
    const appliedImmediately = can(guard.role, "transfer_requests", "update");
    if (appliedImmediately) {
      const moveResult = await applyBranchMove(supabase, employeeId, fromBranchId, toBranchId);
      if (!moveResult.moved) {
        await updateTransferRequestStatus(request_.id, "rejected", { reviewedBy: guard.userId });
        return NextResponse.json(
          { error: "This employee's branch just changed (likely another transfer). Please retry." },
          { status: 409 },
        );
      }
      const approved = await updateTransferRequestStatus(request_.id, "approved", {
        reviewedBy: guard.userId,
      });
      request_ = approved.request || request_;
    }

    await appendAuditLog({
      module: "transfer_requests",
      action: appliedImmediately ? "approved" : "create",
      entity_type: "transfer_request",
      entity_id: request_.id,
      description: appliedImmediately
        ? `Employee ${normalizeText(employeeMeta.full_name, employeeId)} was transferred to ${destination.name}.`
        : `Transfer request raised for employee ${employeeId} to another branch.`,
      status: "success",
      source: "api",
      metadata: { employee_id: employeeId, from_branch_id: fromBranchId, to_branch_id: toBranchId },
    });

    return NextResponse.json(
      { request: request_, applied: appliedImmediately, to_branch_name: destination.name },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "transfer_requests", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);
    const action = normalizeText(body.action).toLowerCase();

    if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "action must be approve or reject." }, { status: 400 });
    }

    const allRequests = await readAllTransferRequests();
    const current = allRequests.find((r) => r.id === id);
    if (!current) {
      return NextResponse.json({ error: "Transfer request not found." }, { status: 404 });
    }

    if (current.status !== "pending") {
      return NextResponse.json(
        { error: `Cannot ${action} a transfer request with status: ${current.status}.` },
        { status: 409 },
      );
    }

    const foreignBranch = denyForeignBranch(guard, current.from_branch_id);
    if (foreignBranch) return foreignBranch;

    if (action === "approve") {
      // Re-check the employee is still in the branch this request was raised
      // against — it may have moved via a different transfer that was
      // approved between this request's creation and this decision.
      const liveFromBranchId = await getEmployeeCurrentBranch(current.employee_id);
      if (String(liveFromBranchId || "") !== String(current.from_branch_id || "")) {
        return NextResponse.json(
          {
            error: "This employee's branch has changed since this request was raised. Reject it and raise a new one.",
          },
          { status: 409 },
        );
      }
    }

    const nextStatus = action === "approve" ? "approved" : "rejected";
    const { request: updated } = await updateTransferRequestStatus(id, nextStatus, {
      reviewedBy: guard.userId,
    });
    if (nextStatus === "approved") {
      const moveResult = await applyBranchMove(
        getAdminClient(),
        current.employee_id,
        current.from_branch_id,
        current.to_branch_id,
      );
      if (!moveResult.moved) {
        // The re-check above should have already caught this — this is a
        // last-resort guard against a move that raced past it.
        await updateTransferRequestStatus(id, "rejected", { reviewedBy: guard.userId });
        return NextResponse.json(
          { error: "This employee's branch changed just now. Please retry." },
          { status: 409 },
        );
      }
    }

    await appendAuditLog({
      module: "transfer_requests",
      action: nextStatus,
      entity_type: "transfer_request",
      entity_id: id,
      description: `Transfer request for employee ${current.employee_id} was ${nextStatus}.`,
      status: "success",
      source: "api",
      metadata: { employee_id: current.employee_id, to_branch_id: current.to_branch_id },
    });

    return NextResponse.json({ request: updated });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
