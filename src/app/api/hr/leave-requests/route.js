import { NextResponse } from "next/server";
import {
  readAllLeaveRequests,
  updateLeaveRequestStatus,
  findOverlappingApprovedLeave,
  cancelApprovedLeaveRequest,
  syncLeaveAttendance,
} from "@/lib/leave-requests/store";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyForeignBranch, denySelfScopeList } from "@/lib/rbac/guard";
import { manilaDateKey } from "@/lib/payroll/periods";
import { notify, notifyEndorsers } from "@/lib/branch-requests-server";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "read");
    if (guard.denied) return guard.denied;
    // Employees (own records only) never list colleagues here.
    const selfDenied = denySelfScopeList(guard);
    if (selfDenied) return selfDenied;

    const url = new URL(request.url);
    const status = String(url.searchParams.get("status") || "pending").trim().toLowerCase();

    // Narrowed in the query itself for a branch-scoped caller, instead of
    // downloading every branch's requests (and their proof documents) first.
    // Every pending request, however old, and the decided ones of the last
    // 12 months (all of them at once was every request ever filed; past
    // 1,000 the oldest pending ones vanished from this queue).
    // pending_accountant is a legacy status from before Leave Approval moved to HR —
    // treat it the same as pending_admin so any request stuck in that state (submitted
    // before this fix) still surfaces here instead of being invisible.
    const PENDING = ["pending_admin", "pending_accountant"];
    const scope = guard.branchExempt ? {} : { branchId: guard.branchId };
    const since = new Date(Date.now() - 366 * 86400000).toISOString();
    const [pending, history] = await Promise.all([
      readAllLeaveRequests({ ...scope, statuses: PENDING }),
      status === "pending" ? [] : readAllLeaveRequests({ ...scope, excludeStatuses: PENDING, submittedSince: since }),
    ]);
    const allRequests = [...pending, ...history];

    let requests;
    if (status === "all") {
      requests = allRequests;
    } else if (status === "history") {
      requests = history;
    } else if (status === "pending") {
      requests = pending;
    } else {
      requests = allRequests.filter((r) => r.status === status);
    }

    return NextResponse.json({
      requests,
      pending_requests: pending,
      history_requests: history,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "leave_approval", "update");
    if (guard.denied) return guard.denied;

    const body = await request.json();
    const id = String(body.id || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    if (action !== "approve" && action !== "reject" && action !== "cancel") {
      return NextResponse.json({ error: "action must be approve, reject or cancel." }, { status: 400 });
    }

    const [current] = await readAllLeaveRequests({ id });

    if (!current) {
      return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
    }

    const foreignBranch = denyForeignBranch(guard, current.branch_id);
    if (foreignBranch) return foreignBranch;

    const deciderName = String(guard.session?.full_name || guard.session?.email || "").trim();

    // Cancelling approved leave releases its On Leave days (the database
    // trigger archives them), so the employee can tap on those days again.
    // Only while the leave is not over: past leave days may already be paid.
    if (action === "cancel") {
      if (current.status !== "approved") {
        return NextResponse.json({ error: "Only an approved leave request can be cancelled." }, { status: 409 });
      }
      if ((current.end_date || current.start_date) < manilaDateKey()) {
        return NextResponse.json({ error: "This leave has already ended and can no longer be cancelled." }, { status: 409 });
      }
      const cancelled = await cancelApprovedLeaveRequest(id, {
        cancelledBy: guard.userId || null,
        cancelledByName: deciderName || null,
      });
      if (cancelled.conflict) {
        return NextResponse.json(
          { error: "This leave request was already changed by someone else. Refresh to see its current status." },
          { status: 409 },
        );
      }
      const sync = await syncLeaveAttendance(id);

      await appendAuditLog({
        actor: guard,
        module: "leave",
        action: "cancel",
        entity_type: "leave_request",
        entity_id: id,
        branch_id: current.branch_id || null,
        description: `Approved leave for ${current.employee_name} (${current.start_date} to ${current.end_date}) cancelled.`,
        status: "success",
        source: "api",
        metadata: {
          employee_id: current.employee_id,
          leave_type: current.leave_type,
          pay_status: current.pay_status,
          start_date: current.start_date,
          end_date: current.end_date,
          previous_status: current.status,
        },
      });

      try {
        await notify(getAdminClient(), [current.employee_id], {
          kind: "leave_cancelled",
          title: "Your approved leave was cancelled",
          body: `${current.leave_type || "Leave"}, ${current.start_date} to ${current.end_date}${deciderName ? ` · ${deciderName}` : ""}`,
          link_page: "emp-leave",
        });
      } catch { /* never fails the cancellation */ }

      return NextResponse.json({ success: true, new_status: "cancelled", attendance: sync });
    }

    if (current.status !== "pending_admin" && current.status !== "pending_accountant") {
      return NextResponse.json(
        { error: `Cannot ${action} a leave request with status: ${current.status}.` },
        { status: 409 },
      );
    }

    if (action === "approve") {
      // Only this employee's approved requests can overlap.
      const employeeApproved = current.employee_id
        ? await readAllLeaveRequests({ employeeId: current.employee_id, status: "approved" })
        : [];
      const overlap = findOverlappingApprovedLeave(
        employeeApproved,
        current.employee_id,
        current.start_date,
        current.end_date,
        current.id,
      );
      if (overlap) {
        return NextResponse.json(
          {
            error: `This request overlaps an already-approved leave request (${overlap.start_date} to ${overlap.end_date}). Reject or resolve that one first.`,
          },
          { status: 409 },
        );
      }
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    // Conditional on the request still being pending, so two reviewers
    // deciding it at once cannot both win; records who decided.
    const result = await updateLeaveRequestStatus(id, newStatus, {
      fromStatuses: ["pending_admin", "pending_accountant"],
      decidedBy: guard.userId || null,
      decidedByName: deciderName || null,
    });
    if (result.conflict) {
      return NextResponse.json(
        { error: "This leave request was already decided by someone else. Refresh to see its current status." },
        { status: 409 },
      );
    }

    // The branch Admin who recommended it learns HR's decision (2026-10-20).
    await notifyEndorsers(getAdminClient(), "leave_endorsement", id, {
      title: `Leave ${newStatus === "approved" ? "approved" : "rejected"} by HR · ${current.employee_name}`,
      body: `${current.leave_type || "Leave"}, ${current.start_date} to ${current.end_date}${deciderName ? ` · ${deciderName}` : ""}`,
    }).catch(() => 0);

    // The employee's bell (2026-10-20 audit): HR's decision on their request.
    try {
      await notify(getAdminClient(), [current.employee_id], {
        kind: `leave_${newStatus}`,
        title: `Your leave was ${newStatus}`,
        body: `${current.leave_type || "Leave"}, ${current.start_date} to ${current.end_date}${deciderName ? ` · ${deciderName}` : ""}`,
        link_page: "emp-leave",
      });
    } catch { /* never fails the decision */ }

    // Leave decides paid versus unpaid days, so every decision is audited.
    await appendAuditLog({
      actor: guard,
      module: "leave",
      action: action === "approve" ? "approve" : "reject",
      entity_type: "leave_request",
      entity_id: id,
      branch_id: current.branch_id || null,
      description: `Leave request for ${current.employee_name} (${current.start_date} to ${current.end_date}, ${current.pay_status === "without_pay" ? "without pay" : "with pay"}) ${newStatus}.`,
      status: "success",
      source: "api",
      metadata: {
        employee_id: current.employee_id,
        leave_type: current.leave_type,
        pay_status: current.pay_status,
        start_date: current.start_date,
        end_date: current.end_date,
        previous_status: current.status,
      },
    });

    // Approval wrote the On Leave days (database trigger). Days that already
    // have a real tap were left as recorded; HR is told so it can resolve them.
    const sync = action === "approve" ? await syncLeaveAttendance(id) : null;

    return NextResponse.json({
      success: true,
      new_status: newStatus,
      attendance: sync,
      attendance_conflicts: sync?.conflicts || [],
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
