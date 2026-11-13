/**
 * Items waiting on the Super Admin as the FALLBACK approver (2026-11-09 Part D).
 *
 * The Super Admin never decides when a normal approver exists. An item waits
 * here only while no other HR is active:
 *   * an HR's own leave request (pending), and
 *   * a pending payroll run that every active HR is barred from deciding
 *     (it holds their own payslip, or they processed it).
 *
 *   GET                       { items: [...], counts: { leave, payroll_run, total } }
 *   POST { action: "approve" | "reject", item_type: "leave_request" | "payroll_run", id, reason }
 *     A rejection needs a reason (5+ characters). Each decision is audited as
 *     "fallback used" with the reason, and the requester is notified (generic
 *     wording, no amounts). The database refuses it again if an HR is active.
 *
 * fallback_approvals: Super Admin only (src/lib/rbac/permissions.js).
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { applyBalanceSplit, readLeaveRequestsWithoutProof, updateLeaveRequestStatus } from "@/lib/leave-requests/store";
import { PENDING_LEAVE, loadFallbackItems } from "@/lib/rbac/fallback-items";
import { recordFallback, routingErrorResponse } from "@/lib/rbac/routing";
import { describeRunError } from "@/lib/payroll/runs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "fallback_approvals", "read");
    if (guard.denied) return guard.denied;
    return NextResponse.json(await loadFallbackItems(getServiceClient()));
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "fallback_approvals", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "super_admin") return NextResponse.json({ error: "Only the Super Admin is the fallback approver." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const type = String(body.item_type || "").trim();
    const id = String(body.id || "").trim();
    const reason = String(body.reason || "").trim().replace(/\s+/g, " ").slice(0, 500);
    if (!["approve", "reject"].includes(action) || !UUID.test(id)) return NextResponse.json({ error: "Send action (approve or reject), item_type and id." }, { status: 400 });
    if (action === "reject" && reason.length < 5) return NextResponse.json({ error: "Write the reason for rejecting (at least 5 characters). The requester sees it.", code: "reason_required" }, { status: 400 });

    const supabase = getServiceClient();
    const waiting = await loadFallbackItems(supabase);
    const item = waiting.items.find((i) => i.item_type === type && i.id === id);
    if (!item) {
      return NextResponse.json({ error: "This item is not waiting on the fallback (an HR is active for it, or it was decided). The normal approver handles it.", code: "not_fallback" }, { status: 409 });
    }
    const actorName = String(guard.session?.full_name || guard.session?.email || "Super Admin");
    const decided = action === "approve" ? "approved" : "rejected";

    if (type === "leave_request") {
      const [current] = await readLeaveRequestsWithoutProof({ id });
      if (!current) return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
      const result = await updateLeaveRequestStatus(id, decided, {
        fromStatuses: PENDING_LEAVE, decidedBy: guard.userId, decidedByName: actorName, ...(action === "reject" ? { decisionReason: reason } : {}),
      });
      if (result.conflict) return NextResponse.json({ error: "This leave request was already decided. Refresh to see it." }, { status: 409 });
      // Over the yearly paid balance: the extra days become without pay (re-checked at approval).
      if (action === "approve") await applyBalanceSplit(id);
    } else if (type === "payroll_run") {
      const rpc = action === "approve"
        ? await supabase.rpc("approve_payroll_run", { p_run_id: id, p_actor: guard.userId, p_remarks: reason || "Approved by the Super Admin as the fallback (no other HR is active)." })
        : await supabase.rpc("reject_payroll_run", { p_run_id: id, p_actor: guard.userId, p_remarks: reason });
      if (rpc.error) { const failure = describeRunError(rpc.error); return NextResponse.json(failure, { status: failure.status }); }
    } else {
      return NextResponse.json({ error: "Unknown item type." }, { status: 400 });
    }
    await recordFallback(supabase, { actor: guard, ownerId: item.owner_id, ownerName: item.owner_name, itemType: type, itemId: id, what: type === "leave_request" ? "leave request" : "payroll run", decided });
    return NextResponse.json({ success: true, decided, remaining: (await loadFallbackItems(supabase)).counts });
  } catch (error) {
    const routed = routingErrorResponse(error);
    if (routed) return routed;
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
