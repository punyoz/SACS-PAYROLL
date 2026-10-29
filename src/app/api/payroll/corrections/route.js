/**
 * Payroll corrections after approval (src/lib/payroll/corrections.js).
 *
 *   GET    the corrections in reach: the Accountant's branch, or (HR) every branch
 *   POST   { entry_id, kind, amount, payrolls?, reason }          Accountant files
 *   PATCH  { id, action: "resubmit", kind, amount, payrolls?, reason }   Accountant
 *          { id, action: "approve" | "reject", note }                     HR
 *
 * The database functions check the role, the branch and the rules again.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { describeCorrectionError, shapeCorrection } from "@/lib/payroll/corrections";
import { PESO_MAX, pesoLimit } from "@/lib/input-limits";
import { textLimitError } from "@/lib/input-limits";

// The longest text each box takes; the form boxes match.
const TEXT_CAPS = { note: [500, "The note"] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Correct dialog's limits (payroll-corrections.jsx), checked before the
 * database: an amount past numeric(12,2) would otherwise fail as a 500.
 * Returns an error message, or null.
 */
function correctionInputError(body) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > PESO_MAX) return `Enter an amount more than ₱0 and at most ${pesoLimit(PESO_MAX)}.`;
  if (body.payrolls !== undefined && body.payrolls !== null && body.payrolls !== "") {
    const payrolls = Number(body.payrolls);
    if (!Number.isInteger(payrolls) || payrolls < 1 || payrolls > 24) return "Recover over 1 to 24 payslips.";
  }
  if (normalizeText(body.reason).length > 500) return "The reason can be at most 500 characters.";
  return null;
}

function refused(error) {
  const failure = describeCorrectionError(error);
  return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
}

export async function GET(request) {
  try {
    // HR decides them; the Accountant (read) sees its branch's.
    const guard = await requirePermission(request, "payroll_run_approval", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    let query = supabase.from("payroll_corrections").select("*").order("requested_at", { ascending: false }).limit(500);
    if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId || "00000000-0000-0000-0000-000000000000");
    const result = await query;
    if (result.error) {
      const failure = describeCorrectionError(result.error);
      return NextResponse.json({ available: false, error: failure.error, corrections: [] }, { status: failure.status === 503 ? 200 : failure.status });
    }
    const rows = result.data || [];
    const [people, branches] = await Promise.all([
      fetchAllIn(() => supabase.from("profiles").select("id,full_name").order("id", { ascending: true }), "id", rows.map((r) => r.employee_id)),
      supabase.from("branches").select("id,name"),
    ]);
    const nameOf = new Map((people.data || []).map((p) => [p.id, p.full_name]));
    const branchOf = new Map((branches.data || []).map((b) => [b.id, b.name]));
    return NextResponse.json({
      available: true,
      corrections: rows.map((row) => shapeCorrection(row, { employeeName: nameOf.get(row.employee_id), branchName: branchOf.get(row.branch_id) })),
      can: {
        file: guard.role === "accountant",
        decide: guard.role === "hr",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requirePermission(request, "process_payroll", "create");
  if (guard.denied) return guard.denied;
  try {
    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const entryId = normalizeText(body.entry_id);
    if (!UUID.test(entryId)) return NextResponse.json({ error: "Choose the approved payslip to correct." }, { status: 400 });
    const badInput = correctionInputError(body);
    if (badInput) return NextResponse.json({ error: badInput }, { status: 400 });
    const supabase = getAdminClient();
    const result = await supabase.rpc("payroll_correction_file", {
      p_actor: guard.userId,
      p_entry: entryId,
      p_kind: normalizeText(body.kind),
      p_amount: Number(body.amount),
      p_payrolls: Number(body.payrolls) || 1,
      p_reason: normalizeText(body.reason),
    });
    if (result.error) return refused(result.error);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    await appendAuditLog({
      actor: guard, module: "payroll", action: "correction_filed", entity_type: "payroll_correction", entity_id: row?.id,
      description: `Payroll correction filed: ${row?.kind} of ${row?.amount} for the ${row?.period_label} payslip (${row?.payslip_no || "no number"}).`,
      status: "success", source: "api", branch_id: row?.branch_id || null, metadata: { entry_id: entryId, reason: row?.reason },
    });
    return NextResponse.json({ correction: shapeCorrection(row) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    // Over-long text is refused, not cut short (input limits).
    const tooLong = textLimitError(body, TEXT_CAPS);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
    const action = normalizeText(body.action).toLowerCase();
    const id = normalizeText(body.id);
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose the correction." }, { status: 400 });
    const resubmit = action === "resubmit";
    const guard = resubmit
      ? await requirePermission(request, "process_payroll", "update")
      : await requirePermission(request, "payroll_run_approval", "update");
    if (guard.denied) return guard.denied;
    if (!resubmit && !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Approve, reject or resubmit." }, { status: 400 });
    }
    if (resubmit) {
      const badInput = correctionInputError(body);
      if (badInput) return NextResponse.json({ error: badInput }, { status: 400 });
    }
    const supabase = getAdminClient();
    const result = resubmit
      ? await supabase.rpc("payroll_correction_resubmit", {
        p_actor: guard.userId, p_id: id, p_kind: normalizeText(body.kind), p_amount: Number(body.amount),
        p_payrolls: Number(body.payrolls) || 1, p_reason: normalizeText(body.reason),
      })
      : await supabase.rpc("payroll_correction_decide", { p_actor: guard.userId, p_id: id, p_action: action, p_note: normalizeText(body.note) || null });
    if (result.error) return refused(result.error);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    await appendAuditLog({
      actor: guard, module: "payroll", action: `correction_${resubmit ? "resubmitted" : action === "approve" ? "approved" : "rejected"}`,
      entity_type: "payroll_correction", entity_id: id,
      description: `Payroll correction ${resubmit ? "resubmitted" : action === "approve" ? "approved" : "rejected"} for the ${row?.period_label} payslip.${body.note ? ` Note: ${normalizeText(body.note)}` : ""}`,
      status: "success", source: "api", branch_id: row?.branch_id || null,
    });
    return NextResponse.json({ correction: shapeCorrection(row) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
