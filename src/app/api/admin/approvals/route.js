/**
 * Approvals (SACS-Payroll-Permission-Matrix.md row 10a;
 * docs/payroll-schedule-loans-awol.md §5, §6.7, §6.8). One queue, by role:
 *
 *   Admin (own branch) — approve the refused-consent loan decision HR
 *     recommended; approve / reject missed-month subsidy adjustments. No
 *     other payroll edits. (AWOL separations are HR's: /api/hr/awol-cases.)
 *   HR (all branches) — recommend a decision for a refused-consent excess
 *     subsidy advance.
 *   Accountant (own branch) — request a missed-month subsidy adjustment
 *     (cannot approve its own request).
 *   Super Admin — view.
 *
 *   GET
 *   POST   { action: "request_adjustment", subsidy_balance_id, months_missed,
 *            months_label, amount, reason }                       Accountant
 *   PATCH  { action: "recommend_loan_decision", loan_id,
 *            decision: offset_next_subsidy | waive | final_pay | collect, reason }  HR
 *          { action: "approve_loan_decision", loan_id, note }     Admin
 *          { action: "decide_adjustment", adjustment_id, decision: approve | reject, note }  Admin
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { roundPeso } from "@/lib/payroll/money";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";

const peso = (value) => roundPeso(value);
const NOT_READY = "Approvals are not set up yet: apply 20261009010000_payslip_schedule_loans_awol_subsidy.sql.";
const LOAN_DECISIONS = {
  offset_next_subsidy: "Offset against next year's subsidy",
  waive: "Waive (write off)",
  final_pay: "Recover from final pay on separation",
  collect: "Refer for collection",
};

function money(value) {
  return `₱${peso(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dbError(error, fallback) {
  const code = String(error?.code || "");
  if (["P0001", "23514", "23505"].includes(code)) {
    return NextResponse.json({ error: String(error.message || fallback).replace(/^ERROR:\s*/, "") }, { status: 400 });
  }
  return NextResponse.json({ error: sanitizeError(error, fallback) }, { status: 500 });
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "payroll_approvals", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const byId = new Map(staff.map((person) => [person.id, person]));
    const ids = staff.map((person) => person.id);
    const role = guard.role;
    const empty = { loan_decisions: [], adjustments: [], balances: [] };
    if (!ids.length) return NextResponse.json({ available: true, role, ...empty });

    const [loans, adjustments] = await Promise.all([
      supabase.from("payroll_loans").select("*").in("employee_id", ids).eq("awaiting_decision", true),
      fetchAllRows(() => supabase.from("payroll_subsidy_adjustments").select("*").in("employee_id", ids)
        .order("requested_at", { ascending: false }).order("id", { ascending: true })),
    ]);
    if (loans.error || adjustments.error) return NextResponse.json({ available: false, error: NOT_READY, ...empty });

    const balanceIds = [...new Set([
      ...(loans.data || []).map((l) => l.subsidy_balance_id),
      ...(adjustments.data || []).map((a) => a.subsidy_balance_id),
    ].filter(Boolean))];
    const balanceRows = balanceIds.length
      ? (await supabase.from("payroll_subsidy_balances").select("*").in("id", balanceIds)).data || []
      : [];
    const balances = new Map(balanceRows.map((b) => [b.id, b]));
    const name = (id) => byId.get(id)?.full_name || "—";

    // Accountant: open balances it can request adjustments against.
    let requestable = [];
    if (role === "accountant" || role === "super_admin") {
      const open = await supabase.from("payroll_subsidy_balances").select("*").in("employee_id", ids).in("status", ["open"]);
      requestable = (open.data || []).map((b) => ({
        id: b.id, employee_id: b.employee_id, employee_name: name(b.employee_id), year: String(b.subsidy_year_start).slice(0, 4),
        annual_amount: peso(b.annual_amount), eligible_months: b.eligible_months, monthly: peso(Number(b.annual_amount) / 12),
      }));
    }

    return NextResponse.json({
      available: true,
      role,
      loan_decisions: (loans.data || []).map((loan) => ({
        ...loan,
        employee_name: name(loan.employee_id),
        remaining_balance: peso(loan.remaining_balance),
        excess: balances.get(loan.subsidy_balance_id) ? Math.max(0, peso(-Number(balances.get(loan.subsidy_balance_id).remaining))) : peso(loan.remaining_balance),
        decision_label: loan.decision ? LOAN_DECISIONS[loan.decision] : null,
      })),
      adjustments: (adjustments.data || [])
        .filter((a) => role !== "hr")
        .map((a) => ({ ...a, amount: peso(a.amount), employee_name: name(a.employee_id), year: String(balances.get(a.subsidy_balance_id)?.subsidy_year_start || "").slice(0, 4) })),
      balances: requestable,
      decisions: LOAN_DECISIONS,
      can: {
        decide: role === "admin",
        recommend: role === "hr",
        request: role === "accountant",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "payroll_approvals", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    if (normalizeText(body.action) !== "request_adjustment") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const supabase = getAdminClient();

    const balance = await supabase.from("payroll_subsidy_balances").select("*").eq("id", normalizeText(body.subsidy_balance_id)).maybeSingle();
    if (balance.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
    if (!balance.data) return NextResponse.json({ error: "Subsidy balance not found." }, { status: 404 });
    const staff = await loadPayrollStaff(supabase, guard);
    const person = staff.find((p) => p.id === balance.data.employee_id);
    if (!person) return NextResponse.json({ error: "That teacher is not in your branch." }, { status: 403 });
    if (person.id === guard.userId) return NextResponse.json({ error: "You cannot request an adjustment for yourself." }, { status: 403 });

    const months = Number(body.months_missed);
    const amount = peso(body.amount);
    const reason = normalizeText(body.reason).slice(0, 1000);
    const label = normalizeText(body.months_label).slice(0, 60);
    if (!(Number.isInteger(months) && months >= 1 && months <= 12)) return NextResponse.json({ error: "Months missed: 1 to 12." }, { status: 400 });
    if (!label) return NextResponse.json({ error: "Name the months (e.g. May–Jul 2027)." }, { status: 400 });
    if (!(amount > 0)) return NextResponse.json({ error: "Enter the amount." }, { status: 400 });
    if (reason.length < 10) return NextResponse.json({ error: "Give the reason (at least 10 characters)." }, { status: 400 });

    const result = await supabase.from("payroll_subsidy_adjustments").insert({
      employee_id: person.id, subsidy_balance_id: balance.data.id, months_missed: months, months_label: label,
      amount, reason, status: "pending", requested_by: guard.userId || null, requested_by_name: actorName(guard),
    }).select("id").maybeSingle();
    if (result.error) return dbError(result.error, "The adjustment was not saved.");
    await appendAuditLog({
      actor: guard, module: "payroll", action: "subsidy_adjustment_request", entity_type: "payroll_subsidy_adjustment",
      entity_id: result.data?.id || person.id, status: "success", source: "api",
      description: `Missed-month subsidy adjustment ${money(amount)} (${label}) requested for ${personLabel(person)}; waits for the Admin.`,
      metadata: { months, amount, label, reason },
    });
    return NextResponse.json({ success: true, id: result.data?.id || null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "payroll_approvals", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const inReach = (id) => staff.find((p) => p.id === id) || null;
    const now = new Date().toISOString();
    const note = normalizeText(body.note).slice(0, 1000);

    if (action === "recommend_loan_decision" || action === "approve_loan_decision") {
      const found = await supabase.from("payroll_loans").select("*").eq("id", normalizeText(body.loan_id)).maybeSingle();
      if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
      const loan = found.data;
      const person = loan ? inReach(loan.employee_id) : null;
      if (!loan || !person) return NextResponse.json({ error: "Loan not found." }, { status: 404 });
      if (!loan.awaiting_decision) return NextResponse.json({ error: "This advance is not waiting for a decision." }, { status: 409 });

      if (action === "recommend_loan_decision") {
        if (guard.role !== "hr") return NextResponse.json({ error: "HR recommends; the Admin approves." }, { status: 403 });
        const decision = normalizeText(body.decision);
        const reason = normalizeText(body.reason).slice(0, 1000);
        if (!LOAN_DECISIONS[decision]) return NextResponse.json({ error: "Choose one of the four options." }, { status: 400 });
        if (reason.length < 10) return NextResponse.json({ error: "Give the reason (at least 10 characters)." }, { status: 400 });
        const result = await supabase.from("payroll_loans").update({
          decision, decision_reason: reason, decision_recommended_by: guard.userId || null,
          decision_recommended_by_name: actorName(guard), decision_recommended_at: now,
          decision_approved_by: null, decision_approved_by_name: null, decision_approved_at: null,
        }).eq("id", loan.id);
        if (result.error) return dbError(result.error, "Not saved.");
        await appendAuditLog({ actor: guard, module: "hr", action: "loan_decision_recommend", entity_type: "payroll_loan", entity_id: loan.id, status: "success", source: "api",
          description: `HR recommends "${LOAN_DECISIONS[decision]}" for ${personLabel(person)}'s excess subsidy advance; waits for the Admin.`, metadata: { decision, reason } });
        return NextResponse.json({ success: true });
      }

      if (guard.role !== "admin") return NextResponse.json({ error: "Only the branch Admin approves." }, { status: 403 });
      if (!loan.decision || !loan.decision_recommended_by) return NextResponse.json({ error: "HR has not recommended a decision yet." }, { status: 409 });
      const approved = await supabase.from("payroll_loans").update({
        decision_approved_by: guard.userId || null, decision_approved_by_name: actorName(guard), decision_approved_at: now,
        status_reason: `${LOAN_DECISIONS[loan.decision]} (approved)${note ? `: ${note}` : ""}`,
      }).eq("id", loan.id);
      if (approved.error) return dbError(approved.error, "Not saved.");
      // A waiver closes the advance now; the other decisions act later
      // (next year's payout, final pay, or outside payroll).
      if (loan.decision === "waive" && Number(loan.remaining_balance) > 0) {
        const waived = await supabase.from("payroll_loan_payments").insert({
          loan_id: loan.id, employee_id: loan.employee_id, kind: "waiver", amount: peso(loan.remaining_balance), amount_due: peso(loan.remaining_balance),
          note: `Waived: ${loan.decision_reason}`, created_by: guard.userId || null, created_by_name: actorName(guard),
        });
        if (waived.error) return dbError(waived.error, "The waiver was not saved.");
      }
      await appendAuditLog({ actor: guard, module: "admin", action: "loan_decision_approve", entity_type: "payroll_loan", entity_id: loan.id, status: "success", source: "api",
        description: `Admin approved "${LOAN_DECISIONS[loan.decision]}" for ${personLabel(person)}'s ${money(loan.remaining_balance)} excess subsidy advance.`,
        metadata: { decision: loan.decision, note: note || null } });
      return NextResponse.json({ success: true });
    }

    if (action === "decide_adjustment") {
      if (guard.role !== "admin") return NextResponse.json({ error: "Only the branch Admin approves adjustments." }, { status: 403 });
      const found = await supabase.from("payroll_subsidy_adjustments").select("*").eq("id", normalizeText(body.adjustment_id)).maybeSingle();
      if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
      const row = found.data;
      const person = row ? inReach(row.employee_id) : null;
      if (!row || !person) return NextResponse.json({ error: "Adjustment not found in your branch." }, { status: 404 });
      if (row.status !== "pending") return NextResponse.json({ error: "Already decided." }, { status: 409 });
      if (row.requested_by && row.requested_by === guard.userId) return NextResponse.json({ error: "You cannot approve your own request." }, { status: 403 });
      const decision = normalizeText(body.decision);
      if (!["approve", "reject"].includes(decision)) return NextResponse.json({ error: "Approve or reject." }, { status: 400 });
      if (decision === "reject" && note.length < 5) return NextResponse.json({ error: "Give the reason for rejecting (at least 5 characters)." }, { status: 400 });
      const result = await supabase.from("payroll_subsidy_adjustments").update({
        status: decision === "approve" ? "approved" : "rejected", decided_by: guard.userId || null,
        decided_by_name: actorName(guard), decided_by_role: "admin", decided_at: now, decision_note: note || null,
      }).eq("id", row.id);
      if (result.error) return dbError(result.error, "Not saved.");
      await appendAuditLog({ actor: guard, module: "admin", action: `subsidy_adjustment_${decision}`, entity_type: "payroll_subsidy_adjustment", entity_id: row.id, status: "success", source: "api",
        description: `${decision === "approve" ? "Approved" : "Rejected"} the ${money(row.amount)} subsidy adjustment (${row.months_label}) for ${personLabel(person)}${decision === "approve" ? "; paid on the next 16–end payslip" : `: ${note}`}.`,
        metadata: { decision, note: note || null } });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
