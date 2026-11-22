/**
 * HR → Final pay approvals (supabase/migrations/20261120010000_final_pay_hr_approval.sql).
 *
 *   GET   ?count=1   { pending } for the sidebar badge
 *   GET              the final pay submissions in reach: pending first (with
 *                    the full breakdown, the 30-day deadline, loans left for
 *                    collection, any overpayment), then the decided ones
 *   PATCH { id, action: "approve" | "reject", reason }
 *
 * Reach: HR sees the final pay of its home branch (the employee's branch at
 * separation); an HR without a home branch reaches every branch, as on every
 * other HR page. The Super Admin sees every branch (read-only here) and
 * decides from Fallback approvals (/api/super-admin/fallback) only when no
 * such HR is active (the payroll-run stand-in rule). payroll_final_pay_decide
 * checks all of it again, and that nobody decides their own submission or
 * their own final pay. HR never changes an amount: it approves or rejects
 * the snapshot the Accountant submitted.
 */

import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/branch-requests-server";
import { activeHrIds } from "@/lib/rbac/routing";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { manilaDateKey } from "@/lib/payroll/periods";
import { SUBMISSIONS, deadlineOf, describeDecideError, notifyFinalPayDecision, shapeSubmission } from "@/lib/payroll/final-pay-approval";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller's reach: { branchId } (null = every branch), or a 403. */
async function reach(supabase, guard) {
  if (guard.role === "super_admin") return { branchId: null };
  if (guard.role !== "hr") return { denied: NextResponse.json({ error: "Only HR approves final pay." }, { status: 403 }) };
  const me = await supabase.from("profiles").select("branch_id").eq("id", guard.userId).maybeSingle();
  return { branchId: me.data?.branch_id || null };
}

/** Active HR who may decide this row (home branch matches or none; not the submitter or the employee). */
async function eligibleHr(supabase, row) {
  const ids = await activeHrIds(supabase);
  if (!ids.length) return [];
  const hr = await fetchAllIn(() => supabase.from("profiles").select("id,branch_id").order("id", { ascending: true }), "id", ids);
  return (hr.data || []).filter((h) => (!h.branch_id || h.branch_id === row.branch_id) && h.id !== row.submitted_by && h.id !== row.employee_id).map((h) => h.id);
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "payroll_run_approval", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const scope = await reach(supabase, guard);
    if (scope.denied) return scope.denied;
    const url = new URL(request.url);

    let query = supabase.from(SUBMISSIONS).select("*").order("submitted_at", { ascending: false }).limit(500);
    if (scope.branchId) query = query.eq("branch_id", scope.branchId);
    if (url.searchParams.get("count") === "1") query = query.eq("status", "pending");
    const result = await query;
    if (result.error) return NextResponse.json({ available: false, error: "Final pay approval is not set up yet (migration 20261120010000).", rows: [] });
    const rows = result.data || [];
    if (url.searchParams.get("count") === "1") return NextResponse.json({ pending: rows.length });

    const branchIds = [...new Set(rows.map((r) => r.branch_id).filter(Boolean))];
    const branches = branchIds.length ? (await supabase.from("branches").select("id,name").in("id", branchIds)).data || [] : [];
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const today = manilaDateKey();
    const fallbackFor = new Map();
    if (guard.role === "super_admin") {
      for (const row of rows.filter((r) => r.status === "pending")) fallbackFor.set(row.id, !(await eligibleHr(supabase, row)).length);
    }

    const shaped = rows.map((row) => {
      const fp = row.item?.entry?.payroll?.final_pay || {};
      const pending = row.status === "pending";
      const mineToDecide = guard.role === "hr" ? guard.userId !== row.submitted_by && guard.userId !== row.employee_id : Boolean(fallbackFor.get(row.id));
      return {
        ...shapeSubmission(row),
        employee_id: row.employee_id, employee_name: row.employee_name, employee_code: row.item?.entry?.employee_code || null,
        branch_id: row.branch_id, branch_name: branchName.get(row.branch_id) || "—", separated_on: row.separated_on,
        separation: fp.separation || null,
        // The deadline runs until HR approves; shown on what is still waiting.
        ...(pending ? deadlineOf(row.separated_on, today) : {}),
        breakdown: fp.breakdown || null,
        // The unused leave line as the Accountant's screen shows it (shown only when it paid something).
        leave_conversion: fp.leave_conversion?.enabled ? { ...fp.leave_conversion, daily: (row.item?.incentives || []).find((i) => i.type === "leave_conversion")?.rate ?? 0, note: "" } : null,
        salary: row.item?.entry?.payroll?.basic_salary ?? null,
        uncovered: row.effects?.uncovered || [],
        can_decide: pending && mineToDecide,
        fallback: guard.role === "super_admin" && pending && Boolean(fallbackFor.get(row.id)),
      };
    });
    shaped.sort((a, b) => (a.status === "pending") === (b.status === "pending")
      ? (a.status === "pending" ? (a.days_left ?? 0) - (b.days_left ?? 0) : String(b.decided_at || b.submitted_at).localeCompare(String(a.decided_at || a.submitted_at)))
      : a.status === "pending" ? -1 : 1);
    return NextResponse.json({ available: true, rows: shaped, scope: scope.branchId ? "branch" : "all", branch_name: scope.branchId ? branchName.get(scope.branchId) || null : null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "payroll_run_approval", "read");
    if (guard.denied) return guard.denied;
    // HR decides here; the Super Admin stands in from Fallback approvals (/api/super-admin/fallback).
    if (guard.role !== "hr") return NextResponse.json({ error: "Only HR approves or rejects final pay. The Super Admin stands in from Fallback approvals when no HR may decide it." }, { status: 403 });
    const supabase = getAdminClient();
    const scope = await reach(supabase, guard);
    if (scope.denied) return scope.denied;
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);
    const action = normalizeText(body.action);
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose the final pay." }, { status: 400 });
    if (!["approve", "reject"].includes(action)) return NextResponse.json({ error: "Approve or reject." }, { status: 400 });
    // Part H: a preset remark (required to reject), audited with the decision.
    const remark = await resolveRemark(supabase, body.remark, { decision: action, entityType: "final_pay", fallbackText: body.reason });
    if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });
    const reason = normalizeText(remark.text).slice(0, 500);
    if (action === "reject" && reason.length < 5) return NextResponse.json({ error: "Give the reason for rejecting (at least 5 characters)." }, { status: 400 });

    const before = await supabase.from(SUBMISSIONS).select("*").eq("id", id).maybeSingle();
    if (!before.data) return NextResponse.json({ error: "Final pay not found." }, { status: 404 });
    const row = before.data;
    if (scope.branchId && row.branch_id !== scope.branchId) return NextResponse.json({ error: "This final pay belongs to another branch's HR." }, { status: 403 });

    const decider = remarkClient(remark, { decision: action, entityType: "final_pay", module: "payroll", table: "payroll_final_pay_submissions", ids: [id], actor: guard });
    const { data, error } = await decider.rpc("payroll_final_pay_decide", { p_actor: guard.userId, p_id: id, p_action: action, p_reason: reason || null });
    if (error) {
      const failure = describeDecideError(error);
      return NextResponse.json({ error: failure.error }, { status: failure.status });
    }

    await notifyFinalPayDecision(supabase, notify, row, action, reason);
    await appendAuditLog({
      actor: guard, module: "payroll", action: action === "approve" ? "final_pay_approved" : "final_pay_rejected", entity_type: "final_pay_submission", entity_id: id,
      status: "success", source: "api",
      description: action === "approve"
        ? `Final pay for ${row.employee_name} approved and released (${data?.payslip_no || "payslip"}, release ${row.release_on}).`
        : `Final pay for ${row.employee_name} rejected: ${reason}.`,
      metadata: { payslip_no: data?.payslip_no || null, release_on: row.release_on },
    });
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
