/**
 * Incentives, overload and loans waiting for HR (20261027020000, decision
 * 2026-10-27): the Accountant files them in Incentives & Overload and Loans;
 * HR approves or rejects; payroll uses only approved ones.
 *
 *   GET    ?status=pending|decided|all   every item in reach: HR every branch,
 *          the Accountant its own branch (read-only, to follow its items)
 *   PATCH  { kind: "incentive" | "loan" | "rule_incentive", id, decision: "approve" | "reject", note }
 *          (rule_incentive: Perfect Attendance / Early Bird the system computed,
 *          Part E step 6, incentive_recommendation_decide())
 *          HR only; payroll_adjustment_decide() checks the role again and
 *          refuses an item already decided. A rejection needs a reason. The
 *          Accountant who filed it is notified.
 */

import { refuseOwnItem } from "@/lib/rbac/routing";
import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { NextResponse } from "next/server";
import { itemKindLabel, withPayTypeNames } from "@/lib/payroll/pay-types";
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
import { textLimitError } from "@/lib/input-limits";
import { isLimitedLoanType, loadLoanLimits, loanLimitSummary } from "@/lib/payroll/loan-limit";
import { RULE_INCENTIVE_LABELS } from "@/lib/payroll/incentive-recommendations";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { note: [500, "The note"] };

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

    const [incentives, loans, people, branches, ruleIncentives] = await Promise.all([
      fetchAllRows(() => scoped(supabase.from("payroll_monthly_incentives")
        .select("id,employee_id,branch_id,item_date,kind,description,amount,hours,created_by_name,created_at,approval_status,decided_by_name,decided_at,decision_note,reason,non_taxable,pay_type_id")
        .eq("archived", false).order("created_at", { ascending: false }).order("id", { ascending: true }))),
      fetchAllRows(() => scoped(supabase.from("payroll_loans")
        .select("id,employee_id,branch_id,loan_type,description,date_granted,principal,interest_pct,total_payable,amortization,number_of_payrolls,start_period,created_by_name,created_at,approval_status,decided_by_name,decided_at,decision_note")
        .neq("loan_type", "subsidy_advance").order("created_at", { ascending: false }).order("id", { ascending: true }))),
      supabase.from("profiles").select("id,full_name,employee_id"),
      supabase.from("branches").select("id,name"),
      // Part E step 6: the system's Perfect Attendance / Early Bird (none until 20261124080000).
      fetchAllRows(() => scoped(supabase.from("incentive_recommendations")
        .select("id,employee_id,branch_id,pay_period,kind,amount,reasons,status,created_at,decided_by_name,decided_at,decision_note,needs_review")
        .neq("status", "withdrawn").order("created_at", { ascending: false }).order("id", { ascending: true }))),
    ]);
    if (incentives.error || loans.error) {
      return NextResponse.json({ available: false, items: [], error: "Approvals are not set up yet: apply 20261027020000_adjustment_approvals.sql." });
    }
    const person = new Map((people.data || []).map((p) => [p.id, p]));
    // The salary limit of each employee with a pending loan (20261126050000), for HR to see before approving.
    const pendingLoanOwners = (loans.data || []).filter((row) => row.approval_status === "pending" && isLimitedLoanType(row.loan_type)).map((row) => row.employee_id);
    const limits = await loadLoanLimits(supabase, pendingLoanOwners);
    const branch = new Map((branches.data || []).map((b) => [b.id, b.name]));
    const base = (row) => ({
      id: row.id, employee_id: row.employee_id, employee_name: person.get(row.employee_id)?.full_name || "—",
      employee_code: person.get(row.employee_id)?.employee_id || "", branch_name: branch.get(row.branch_id) || "—",
      filed_by: row.created_by_name || null, filed_at: row.created_at, ...approvalFields(row),
    });
    const items = [
      ...(await withPayTypeNames(supabase, incentives.data || [])).map((row) => ({
        ...base(row), kind: "incentive", item_kind: row.kind,
        // A custom type (2026-11-26) shows its own name.
        type_label: itemKindLabel(row),
        amount_label: row.kind === "overload" ? `${row.hours} h` : row.amount < 0 ? `−${money(-row.amount)}` : money(row.amount),
        detail: `${row.description}${row.reason ? ` · Reason: ${row.reason}` : ""}${row.non_taxable ? (row.kind === "custom" ? " · Not taxable" : " · Non-taxable correction") : ""} · dated ${String(row.item_date).slice(0, 10)}`,
      })),
      ...(ruleIncentives.error ? [] : ruleIncentives.data || []).map((row) => ({
        ...base({ ...row, created_by_name: "System (rule)", approval_status: row.status }), kind: "rule_incentive",
        type_label: `${RULE_INCENTIVE_LABELS[row.kind] || "Incentive"} (system)`, amount_label: money(row.amount),
        detail: `${row.pay_period}${(row.reasons || []).length ? ` · ${row.reasons.join("; ")}` : ""}${row.needs_review ? ` · Check: ${row.needs_review}` : ""}`,
        needs_review: row.needs_review || null,
      })),
      ...(loans.data || []).map((row) => ({
        ...base(row), kind: "loan", type_label: LOAN_TYPE_LABELS[row.loan_type] || row.loan_type,
        amount_label: money(row.total_payable ?? row.principal),
        detail: `${row.description ? `${row.description} · ` : ""}${money(row.amortization)} per 16–end payslip from ${row.start_period}, ${row.number_of_payrolls} payslips`
          + (row.approval_status === "pending" && limits.byEmployee.get(row.employee_id)
            ? ` · ${loanLimitSummary(limits.byEmployee.get(row.employee_id)).replace("already owed", "owed with this loan").replace("you can borrow up to", "room left")}`
            : ""),
        loan_limit: row.approval_status === "pending" ? limits.byEmployee.get(row.employee_id) || null : null,
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
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const kind = normalizeText(body.kind);
    const id = normalizeText(body.id);
    const decision = normalizeText(body.decision);
    if (!["incentive", "loan", "rule_incentive"].includes(kind) || !UUID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!["approve", "reject"].includes(decision)) return NextResponse.json({ error: "Approve or reject." }, { status: 400 });

    const supabase = getAdminClient();
    // Nobody approves their own incentive, overload or loan (2026-11-23).
    const table = kind === "loan" ? "payroll_loans" : kind === "rule_incentive" ? "incentive_recommendations" : "payroll_monthly_incentives";
    const owner = (await supabase.from(table).select("employee_id").eq("id", id).maybeSingle()).data;
    if (owner && String(owner.employee_id) === String(guard.userId)) return await refuseOwnItem(guard, { module: "payroll", entityType: kind, entityId: id, what: kind === "loan" ? "loan" : "incentive" });
    // Part H: a preset remark (required to reject), audited with the decision on the item's own table.
    const remark = await resolveRemark(supabase, body.remark, { decision, entityType: "adjustment", fallbackText: body.note });
    if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });
    const note = normalizeText(remark.text).slice(0, 500);
    if (decision === "reject" && note.length < 5) return NextResponse.json({ error: "Give the reason for rejecting it (at least 5 characters)." }, { status: 400 });
    const decider = remarkClient(remark, { decision, entityType: "adjustment", module: "payroll", table, ids: [id], actor: guard });
    const result = kind === "rule_incentive"
      ? await decider.rpc("incentive_recommendation_decide", { p_actor: guard.userId, p_id: id, p_decision: decision, p_note: note || null })
      : await decider.rpc("payroll_adjustment_decide", { p_actor: guard.userId, p_kind: kind, p_id: id, p_decision: decision, p_note: note || null });
    if (result.error) {
      const failure = describeDecisionError(result.error);
      if (failure.code === "loan_limit") {
        const loan = (await supabase.from("payroll_loans").select("employee_id,total_payable").eq("id", id).maybeSingle()).data;
        const info = loan ? (await loadLoanLimits(supabase, [loan.employee_id], { exclude: id })).byEmployee.get(loan.employee_id) : null;
        await appendAuditLog({
          actor: guard, module: "payroll", action: "loan_limit_refused", entity_type: "payroll_loan", entity_id: id, status: "failed", source: "api",
          description: `HR approval of a ${money(loan?.total_payable)} loan refused: limit ${money(info?.loan_limit)}, already owed ${money(info?.owed)}.`,
          metadata: { stage: "approval", loan_id: id, employee_id: loan?.employee_id || null, amount: roundPeso(loan?.total_payable), loan_limit: info?.loan_limit ?? null, owed: info?.owed ?? null, room: info?.room ?? null },
        });
      }
      return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
    }
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const employee = row?.employee_id ? (await supabase.from("profiles").select("full_name").eq("id", row.employee_id).maybeSingle()).data : null;
    const what = kind === "loan" ? "loan" : kind === "rule_incentive" ? "rule-based incentive" : "incentive / overload";
    const verb = decision === "approve" ? "approved" : "rejected";

    await appendAuditLog({
      actor: guard, module: "payroll", action: `adjustment_${verb}`, entity_type: kind === "loan" ? "payroll_loan" : kind === "rule_incentive" ? "incentive_recommendation" : "payroll_monthly_incentive",
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
    return NextResponse.json({ success: true, approval_status: row?.approval_status || row?.status || (decision === "approve" ? "approved" : "rejected") });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
