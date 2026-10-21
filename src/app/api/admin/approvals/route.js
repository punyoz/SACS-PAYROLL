/**
 * Subsidies (docs/payroll-schedule-loans-awol.md §6.7, §6.8; decision of
 * 2026-10-21): the Accountant processes, HR approves. Every subsidy item is
 * a row of payroll_subsidy_requests (20261021010000) and moves only through
 * the database functions, which check the person's role themselves:
 *
 *   pending ─► processed ─► approved ─► applied        (rejected ─► processed again)
 *
 *   Accountant (own branch) — processes: a missed-month adjustment, a cash
 *     subsidy advance, or the settlement of an excess advance the system
 *     raised; fixes and resubmits what HR rejected. Never decides.
 *   HR (all branches) — approves or rejects (a reason is required). Never
 *     processes.
 *   Admin, Super Admin, Employee — no access (src/lib/rbac/permissions.js).
 *
 *   GET    every request in reach (they are never removed), the decision
 *          history, and for the Accountant the open balances it can process
 *   POST   { action: "process", request_id?, kind, subsidy_balance_id, loan_id?,
 *            amount, reason, details }                                  Accountant
 *          ("request_adjustment" is the old name of process / adjustment)
 *   PATCH  { action: "decide", request_id, decision: approve | reject, note }   HR
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { roundPeso } from "@/lib/payroll/money";
import { manilaDateKey } from "@/lib/payroll/periods";
import { nextSecondHalf, suggestedAmortization, validateLoanInput, validateSubsidyAdvanceInput } from "@/lib/payroll/loans";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";
import {
  EXCESS_OPTIONS,
  SUBSIDY_KIND_LABELS,
  advanceAvailable,
  decisionHistory,
  describeSubsidyError,
  shapeSubsidyRequest,
} from "@/lib/payroll/subsidy-requests";

const peso = (value) => roundPeso(value);
const NOT_READY = "Subsidy processing is not set up yet: apply 20261021010000_subsidy_processing.sql.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(value) {
  return `₱${peso(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function refused(error) {
  const failure = describeSubsidyError(error);
  return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
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
    const can = { process: role === "accountant", decide: role === "hr" };
    const empty = { requests: [], balances: [], history: [], options: EXCESS_OPTIONS, can };
    if (!ids.length) return NextResponse.json({ available: true, role, ...empty });

    // The system raises a pending settlement for any advance above the
    // teacher's subsidy (idempotent), so the Accountant sees it to process.
    await supabase.rpc("subsidy_requests_raise_excess", { p_employee_ids: ids }).then(() => {}, () => {});

    const rows = await fetchAllRows(() => supabase.from("payroll_subsidy_requests").select("*").in("employee_id", ids)
      .order("requested_at", { ascending: false }).order("id", { ascending: true }));
    if (rows.error) return NextResponse.json({ available: false, error: NOT_READY, role, ...empty });

    const balanceIds = [...new Set((rows.data || []).map((r) => r.subsidy_balance_id).filter(Boolean))];
    const balanceRows = balanceIds.length
      ? (await supabase.from("payroll_subsidy_balances").select("id,subsidy_year_start").in("id", balanceIds)).data || []
      : [];
    const yearOf = new Map(balanceRows.map((b) => [b.id, String(b.subsidy_year_start || "").slice(0, 4)]));
    const name = (id) => byId.get(id)?.full_name || "—";
    const requests = (rows.data || []).map((r) => shapeSubsidyRequest(r, { employeeName: name(r.employee_id), year: yearOf.get(r.subsidy_balance_id) || null }));

    // Accountant: the open balances it can process an adjustment or an advance against.
    let balances = [];
    if (role === "accountant") {
      const open = await supabase.from("payroll_subsidy_balances").select("*").in("employee_id", ids).eq("status", "open");
      const today = manilaDateKey();
      balances = (open.data || []).filter((b) => b.employee_id !== guard.userId).map((b) => ({
        id: b.id, employee_id: b.employee_id, employee_name: name(b.employee_id), year: String(b.subsidy_year_start).slice(0, 4),
        annual_amount: peso(b.annual_amount), eligible_months: b.eligible_months, monthly: peso(Number(b.annual_amount) / 12),
        advance_available: advanceAvailable(b, today),
      }));
    }

    return NextResponse.json({
      available: true,
      role,
      requests,
      history: decisionHistory(requests),
      balances,
      options: EXCESS_OPTIONS,
      can,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "payroll_approvals", "create");
    if (guard.denied) return guard.denied;
    if (guard.role !== "accountant") return NextResponse.json({ error: "Only the Accountant processes a subsidy.", code: "forbidden" }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    if (action !== "process" && action !== "request_adjustment") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const supabase = getAdminClient();
    const requestId = UUID.test(normalizeText(body.request_id)) ? normalizeText(body.request_id) : null;

    // A resubmission keeps its kind, teacher and balance.
    let existing = null;
    if (requestId) {
      const found = await supabase.from("payroll_subsidy_requests").select("*").eq("id", requestId).maybeSingle();
      if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
      existing = found.data;
      if (!existing) return NextResponse.json({ error: "Subsidy request not found." }, { status: 404 });
    }
    const kind = existing?.kind || (action === "request_adjustment" ? "adjustment" : normalizeText(body.kind));
    if (!SUBSIDY_KIND_LABELS[kind]) return NextResponse.json({ error: "Choose what you are processing." }, { status: 400 });

    const staff = await loadPayrollStaff(supabase, guard);
    let balance = null;
    const balanceId = existing?.subsidy_balance_id || normalizeText(body.subsidy_balance_id);
    if (UUID.test(balanceId)) {
      const found = await supabase.from("payroll_subsidy_balances").select("*").eq("id", balanceId).maybeSingle();
      balance = found.data || null;
    }
    if (!balance) return NextResponse.json({ error: "Subsidy balance not found." }, { status: 404 });
    const person = staff.find((p) => p.id === balance.employee_id);
    if (!person) return NextResponse.json({ error: "That teacher is not in your branch." }, { status: 403 });

    const reason = normalizeText(body.reason).slice(0, 1000);
    const raw = body.details && typeof body.details === "object" ? body.details : {};
    let details = {};
    let amount = peso(body.amount);
    if (kind === "adjustment") {
      // Old field names (request_adjustment) are still accepted.
      details = {
        months_missed: Number(raw.months_missed ?? body.months_missed),
        months_label: normalizeText(raw.months_label ?? body.months_label).slice(0, 60),
      };
    } else if (kind === "advance") {
      const dateGranted = normalizeText(raw.date_granted, manilaDateKey());
      const invalid = validateSubsidyAdvanceInput({ principal: amount, date_granted: dateGranted }, advanceAvailable(balance, dateGranted));
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      details = { date_granted: dateGranted, description: normalizeText(raw.description).slice(0, 200) || null, final_pay_authorized: raw.final_pay_authorized !== false };
    } else {
      const option = normalizeText(raw.option);
      if (!EXCESS_OPTIONS[option]) return NextResponse.json({ error: "Choose how the excess is settled." }, { status: 400 });
      details = { option };
      if (option === "convert") {
        if (raw.consent_signed !== true) return NextResponse.json({ error: "The teacher's signed consent is required to deduct from salary." }, { status: 400 });
        const excess = Math.max(0, peso(-Number(balance.remaining)));
        const payrolls = Number(raw.number_of_payrolls) || 1;
        const amortization = raw.amortization ? peso(raw.amortization) : suggestedAmortization(excess, payrolls);
        const startPeriod = normalizeText(raw.start_period, nextSecondHalf(manilaDateKey()));
        const invalid = validateLoanInput({ loan_type: "cash_advance", principal: excess || 1, interest_pct: 0, number_of_payrolls: payrolls, amortization: Math.min(amortization, excess || amortization), date_granted: manilaDateKey(), start_period: startPeriod });
        if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
        details = { option, consent_signed: true, number_of_payrolls: payrolls, amortization, start_period: startPeriod };
      }
      amount = null; // the database works out the excess
    }

    const result = await supabase.rpc("subsidy_request_process", {
      p_actor: guard.userId,
      p_request_id: requestId,
      p_kind: kind,
      p_employee_id: person.id,
      p_balance_id: balance.id,
      p_loan_id: kind === "excess_settlement" ? (existing?.loan_id || normalizeText(body.loan_id) || null) : null,
      p_amount: amount,
      p_reason: reason || null,
      p_details: details,
    });
    if (result.error) return refused(result.error);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;

    await appendAuditLog({
      actor: guard, module: "payroll", action: existing?.status === "rejected" ? "subsidy_resubmitted" : "subsidy_processed",
      entity_type: "payroll_subsidy_request", entity_id: row?.id || person.id, status: "success", source: "api",
      description: `${SUBSIDY_KIND_LABELS[kind]} ${row?.amount ? money(row.amount) : ""} for ${personLabel(person)} processed by ${actorName(guard)}; waits for HR.`,
      metadata: { kind, amount: row?.amount ?? null, details, reason, submission_no: row?.submission_no ?? null },
    });
    return NextResponse.json({ success: true, request: row ? shapeSubsidyRequest(row, { employeeName: person.full_name }) : null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "payroll_approvals", "update");
    if (guard.denied) return guard.denied;
    if (guard.role !== "hr") return NextResponse.json({ error: "Only HR approves or rejects a subsidy.", code: "forbidden" }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    if (["decide_adjustment", "decide_loan_decision", "recommend_loan_decision"].includes(action)) {
      // The one-step decisions are gone (2026-10-21): the Accountant processes first.
      return NextResponse.json({ error: "Decide it from the subsidy list: the Accountant processes it first, then HR approves or rejects.", code: "use_decide" }, { status: 409 });
    }
    if (action !== "decide") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const requestId = normalizeText(body.request_id);
    if (!UUID.test(requestId)) return NextResponse.json({ error: "Subsidy request not found." }, { status: 404 });
    const decision = normalizeText(body.decision);
    if (!["approve", "reject"].includes(decision)) return NextResponse.json({ error: "Approve or reject." }, { status: 400 });
    const note = normalizeText(body.note).slice(0, 1000);

    const supabase = getAdminClient();
    const found = await supabase.from("payroll_subsidy_requests").select("*").eq("id", requestId).maybeSingle();
    if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
    if (!found.data) return NextResponse.json({ error: "Subsidy request not found." }, { status: 404 });
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const person = staff.find((p) => p.id === found.data.employee_id);
    if (!person) return NextResponse.json({ error: "Subsidy request not found." }, { status: 404 });

    const result = await supabase.rpc("subsidy_request_decide", { p_actor: guard.userId, p_request_id: requestId, p_decision: decision, p_note: note || null });
    if (result.error) return refused(result.error);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;

    await appendAuditLog({
      actor: guard, module: "hr", action: `subsidy_${decision === "approve" ? "approved" : "rejected"}`,
      entity_type: "payroll_subsidy_request", entity_id: requestId, status: "success", source: "api",
      description: `${decision === "approve" ? "Approved" : "Rejected"} the ${SUBSIDY_KIND_LABELS[found.data.kind]} ${found.data.amount ? money(found.data.amount) : ""} for ${personLabel(person)}${decision === "reject" ? `: ${note}` : ""}${row?.applied_note ? ` (${row.applied_note})` : ""}.`,
      metadata: { decision, note: note || null, kind: found.data.kind, processed_by: found.data.processed_by_name },
    });
    return NextResponse.json({ success: true, request: row ? shapeSubsidyRequest(row, { employeeName: person.full_name }) : null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
