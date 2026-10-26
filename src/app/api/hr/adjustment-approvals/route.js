/**
 * Incentives, overload and loans waiting for HR (20261027020000, decision
 * 2026-10-27): the Accountant files them in Incentives & Overload and Loans;
 * HR approves or rejects; payroll uses only approved ones.
 *
 *   GET    ?status=pending|decided|all   every item in reach: HR every branch,
 *          the Accountant its own branch (read-only, to follow its items)
 *   PATCH  { kind: "incentive" | "loan", id, decision: "approve" | "reject", note }
 *          HR only; payroll_adjustment_decide() checks the role again and
 *          refuses an item already decided. A rejection needs a reason. The
 *          Accountant who filed it is notified.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { notify } from "@/lib/branch-requests-server";
import { roundPeso } from "@/lib/payroll/money";
import { approvalFields, describeDecisionError } from "@/lib/payroll/adjustment-approvals";
import { LOAN_TYPE_LABELS } from "@/lib/payroll/loans";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (v) => `₱${roundPeso(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function GET(request) {
  const guard = await requirePermission(request, "payroll_approvals", "read");
  if (guard.denied) return guard.denied;
  try {
    const url = new URL(request.url);
    const wanted = ["pending", "decided", "all"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "all";
    const supabase = getAdminClient();
    const branchId = guard.branchExempt ? null : (guard.branchId || "00000000-0000-0000-0000-000000000000");
    const scoped = (query) => (branchId ? query.eq("branch_id", branchId) : query);

    const [incentives, loans, people, branches] = await Promise.all([
      fetchAllRows(() => scoped(supabase.from("payroll_monthly_incentives")
        .select("id,employee_id,branch_id,item_date,kind,description,amount,hours,created_by_name,created_at,approval_status,decided_by_name,decided_at,decision_note")
        .eq("archived", false).order("created_at", { ascending: false }).order("id", { ascending: true }))),
      fetchAllRows(() => scoped(supabase.from("payroll_loans")
        .select("id,employee_id,branch_id,loan_type,description,date_granted,principal,interest_pct,total_payable,amortization,number_of_payrolls,start_period,created_by_name,created_at,approval_status,decided_by_name,decided_at,decision_note")
        .neq("loan_type", "subsidy_advance").order("created_at", { ascending: false }).order("id", { ascending: true }))),
      supabase.from("profiles").select("id,full_name,employee_id"),
      supabase.from("branches").select("id,name"),
    ]);
    if (incentives.error || loans.error) {
      return NextResponse.json({ available: false, items: [], error: "Approvals are not set up yet: apply 20261027020000_adjustment_approvals.sql." });
    }
    const person = new Map((people.data || []).map((p) => [p.id, p]));
    const branch = new Map((branches.data || []).map((b) => [b.id, b.name]));
    const base = (row) => ({
      id: row.id, employee_id: row.employee_id, employee_name: person.get(row.employee_id)?.full_name || "—",
      employee_code: person.get(row.employee_id)?.employee_id || "", branch_name: branch.get(row.branch_id) || "—",
      filed_by: row.created_by_name || null, filed_at: row.created_at, ...approvalFields(row),
    });
    const items = [
      ...(incentives.data || []).map((row) => ({
        ...base(row), kind: "incentive", type_label: row.kind === "overload" ? "Overload" : "Incentive",
        amount_label: row.kind === "overload" ? `${row.hours} h` : money(row.amount), detail: `${row.description} · dated ${String(row.item_date).slice(0, 10)}`,
      })),
      ...(loans.data || []).map((row) => ({
        ...base(row), kind: "loan", type_label: LOAN_TYPE_LABELS[row.loan_type] || row.loan_type,
        amount_label: money(row.total_payable ?? row.principal),
        detail: `${row.description ? `${row.description} · ` : ""}${money(row.amortization)} per 16–end payslip from ${row.start_period}, ${row.number_of_payrolls} payslips`,
      })),
    ]
      .filter((item) => wanted === "all" || (wanted === "pending" ? item.approval_status === "pending" : item.approval_status !== "pending"))
      .sort((a, b) => String(b.filed_at || "").localeCompare(String(a.filed_at || "")));
    return NextResponse.json({
      available: true,
      items,
      pending: items.filter((item) => item.approval_status === "pending").length,
      can_decide: guard.role === "hr",
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const guard = await requirePermission(request, "payroll_approvals", "update");
  if (guard.denied) return guard.denied;
  if (guard.role !== "hr") return NextResponse.json({ error: "Only HR approves or rejects incentives, overload and loans." }, { status: 403 });
  try {
    const body = await request.json().catch(() => ({}));
    const kind = normalizeText(body.kind);
    const id = normalizeText(body.id);
    const decision = normalizeText(body.decision);
    const note = normalizeText(body.note).slice(0, 500);
    if (!["incentive", "loan"].includes(kind) || !UUID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!["approve", "reject"].includes(decision)) return NextResponse.json({ error: "Approve or reject." }, { status: 400 });
    if (decision === "reject" && note.length < 5) return NextResponse.json({ error: "Give the reason for rejecting it (at least 5 characters)." }, { status: 400 });

    const supabase = getAdminClient();
    const result = await supabase.rpc("payroll_adjustment_decide", { p_actor: guard.userId, p_kind: kind, p_id: id, p_decision: decision, p_note: note || null });
    if (result.error) {
      const failure = describeDecisionError(result.error);
      return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
    }
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const employee = row?.employee_id ? (await supabase.from("profiles").select("full_name").eq("id", row.employee_id).maybeSingle()).data : null;
    const what = kind === "loan" ? "loan" : "incentive / overload";
    const verb = decision === "approve" ? "approved" : "rejected";

    await appendAuditLog({
      actor: guard, module: "payroll", action: `adjustment_${verb}`, entity_type: kind === "loan" ? "payroll_loan" : "payroll_monthly_incentive",
      entity_id: id, status: "success", source: "api",
      description: `HR ${verb} the ${what} for ${employee?.full_name || "an employee"}${note ? `: ${note}` : ""} (by ${actorName}).`,
      metadata: { kind, id, decision, note: note || null, employee_id: row?.employee_id || null },
    });
    if (row?.created_by) {
      await notify(supabase, [row.created_by], {
        kind: "adjustment_decision",
        title: `HR ${verb} the ${what}: ${employee?.full_name || "employee"}`,
        body: decision === "approve" ? "Payroll will include it." : `Not paid or deducted. Reason: ${note}`,
        link_page: kind === "loan" ? "ac-loans" : "ac-incentives",
      });
    }
    return NextResponse.json({ success: true, approval_status: row?.approval_status || (decision === "approve" ? "approved" : "rejected") });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
