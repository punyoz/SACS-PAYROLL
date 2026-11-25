/**
 * Government loans (2026-11-25, 20261126060000): SSS and Pag-IBIG loans, encoded by HR from the
 * agency's notice and deducted on 16–end payslips like every deduction (src/lib/payroll/loans.js).
 * The school does not lend; these are the only loans. No amount cap and no salary limit: the
 * agencies set the amounts.
 *
 *   GET    ?status=open|all   the government loans in reach, the people HR can encode for
 *   POST   { employee_id, loan_type: sss_loan | pagibig_loan, loan_kind, reference_no?, principal,
 *            amortization, start_period, number_of_payrolls?, notes?, final_pay_authorized? }
 *   PATCH  { id, action: "edit", amortization?, reference_no?, notes?, reason }
 *          { id, action: "suspend" | "resume" | "end", reason }
 *
 * HR encodes (every branch). Nobody encodes or changes a loan about themselves: an HR officer's
 * own loan is another HR's; when there is no other HR, the Super Admin's (fallback only).
 * Every change is audited with who and why. A change of the amount per payroll applies from the
 * next payslip that is computed; processed payslips never change. "End" stops the deduction
 * (suspended, reason "Ended: …"); a stored loan is never deleted.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { roundPeso } from "@/lib/payroll/money";
import { manilaDateKey, periodForDateKey } from "@/lib/payroll/periods";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";
import { AGENCY_OF, GOVERNMENT_LOAN_KINDS, GOVERNMENT_LOAN_TYPES, LOAN_TYPE_LABELS, deductionLabel, validateGovernmentLoanInput } from "@/lib/payroll/loans";

const peso = (v) => roundPeso(v);
const money = (v) => `₱${peso(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const COLUMNS = "id,employee_id,branch_id,loan_type,agency,loan_kind,reference_no,notes,notice_path,description,date_granted,principal,amortization,number_of_payrolls,start_period,remaining_balance,status,status_reason,status_changed_by_name,status_changed_at,final_pay_authorized,created_by,created_by_name,created_at";

/** Who may encode or change a loan of `person`: HR, never their own; the Super Admin only for an HR officer with no other HR. */
async function refusal(supabase, guard, person) {
  if (!person) return { status: 404, error: "Employee not found." };
  if (String(person.id) === String(guard.userId)) return { status: 403, error: "Nobody encodes or changes a loan about themselves: another HR officer does." };
  if (guard.role === "hr") return null;
  if (guard.role === "super_admin") {
    if (person.role !== "hr") return { status: 403, error: "HR encodes government loans. The Super Admin does only for an HR officer when there is no other HR." };
    const hr = await supabase.from("profiles").select("id,archived").eq("role", "hr");
    const others = (hr.data || []).filter((p) => !p.archived && String(p.id) !== String(person.id));
    if (others.length) return { status: 403, error: "Another HR officer encodes this loan (the Super Admin only when there is none)." };
    return null;
  }
  return { status: 403, error: "Only HR encodes government loans." };
}

function dbError(error, fallback) {
  const message = String(error?.message || "");
  if (/government_reference_uniq|duplicate key/i.test(message)) return NextResponse.json({ error: "This agency loan (same employee, agency and reference number) is already encoded." }, { status: 409 });
  if (/loan_kind:|forbidden:/i.test(message)) return NextResponse.json({ error: message.replace(/^.*?(loan_kind|forbidden):\s*/i, "") }, { status: 403 });
  if (["P0001", "23514"].includes(String(error?.code || ""))) return NextResponse.json({ error: message.replace(/^ERROR:\s*/, "") }, { status: 400 });
  return NextResponse.json({ error: sanitizeError(error, fallback) }, { status: 500 });
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "government_loans", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const byId = new Map(staff.map((p) => [p.id, p]));
    const ids = guard.scope === "self" ? [guard.userId] : staff.map((p) => p.id);
    const result = ids.length
      ? await fetchAllIn(() => supabase.from("payroll_loans").select(COLUMNS).in("loan_type", GOVERNMENT_LOAN_TYPES)
        .order("created_at", { ascending: false }).order("id", { ascending: true }), "employee_id", ids)
      : { data: [], error: null };
    if (result.error) return NextResponse.json({ available: false, loans: [], error: "Government loans are not set up yet: apply 20261126060000_government_loans_cash_advance_limit.sql." });
    const open = url.searchParams.get("status") !== "all";
    const loans = (result.data || [])
      .filter((l) => !open || l.status !== "paid")
      .map((l) => ({
        ...l,
        principal: peso(l.principal), amortization: peso(l.amortization), remaining_balance: peso(l.remaining_balance),
        label: deductionLabel(l), type_label: LOAN_TYPE_LABELS[l.loan_type],
        employee_name: byId.get(l.employee_id)?.full_name || "—", employee_code: byId.get(l.employee_id)?.employee_id || "",
        ended: l.status === "suspended" && /^Ended:/.test(String(l.status_reason || "")),
      }));
    const canEncode = ["hr", "super_admin"].includes(guard.role);
    return NextResponse.json({
      available: true,
      loans,
      kinds: GOVERNMENT_LOAN_KINDS,
      people: canEncode ? staff.filter((p) => !p.archived && String(p.id) !== String(guard.userId)).map((p) => ({ id: p.id, full_name: p.full_name, employee_id: p.employee_id, role: p.role })) : [],
      can_encode: canEncode,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "government_loans", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard);
    const person = staff.find((p) => p.id === normalizeText(body.employee_id)) || null;
    const refused = await refusal(supabase, guard, person);
    if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

    const loanType = normalizeText(body.loan_type);
    const total = Number(body.principal);
    const amortization = Number(body.amortization);
    const payrolls = body.number_of_payrolls === "" || body.number_of_payrolls === undefined || body.number_of_payrolls === null
      ? Math.min(120, Math.max(1, Math.ceil(total / (amortization || 1))))
      : Number(body.number_of_payrolls);
    const input = {
      loan_type: loanType, loan_kind: normalizeText(body.loan_kind), reference_no: normalizeText(body.reference_no),
      principal: total, amortization, number_of_payrolls: payrolls, start_period: normalizeText(body.start_period), notes: normalizeText(body.notes),
    };
    const invalid = validateGovernmentLoanInput(input);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    if (input.start_period < `${manilaDateKey().slice(0, 7)}-16`) {
      return NextResponse.json({ error: "The first deduction must be this month's 16–end payslip or a later one." }, { status: 400 });
    }
    const startLabel = periodForDateKey(input.start_period).label;
    const final = await supabase.from("payroll_entries").select("id").eq("employee_id", person.id).eq("pay_period", startLabel).neq("status", "draft").maybeSingle();
    if (final.data) return NextResponse.json({ error: `${person.full_name}'s ${startLabel} payslip is already processed. Start on a later pay period.` }, { status: 409 });

    const row = {
      employee_id: person.id, branch_id: person.branch_id || null, loan_type: loanType, agency: AGENCY_OF[loanType],
      loan_kind: input.loan_kind, reference_no: input.reference_no || null, notes: input.notes || null,
      description: null, date_granted: manilaDateKey(), principal: peso(total), interest_pct: 0,
      number_of_payrolls: payrolls, amortization: peso(amortization), start_period: input.start_period,
      // Default OFF (decision 2026-11-25): at separation the deduction stops unless the employee signed the authority.
      final_pay_authorized: body.final_pay_authorized === true,
      created_by: guard.userId, created_by_name: actorName(guard),
      // HR's own entry from the agency's notice: approved at once (the database checks HR / Super Admin, not self).
      approval_status: "approved",
    };
    const saved = await supabase.from("payroll_loans").insert(row).select("id").maybeSingle();
    if (saved.error) return dbError(saved.error, "The government loan was not saved.");
    await appendAuditLog({
      actor: guard, module: "payroll", action: "government_loan_create", entity_type: "payroll_loan", entity_id: saved.data?.id || person.id,
      status: "success", source: "api",
      description: `${deductionLabel(row)} ${money(row.principal)} encoded for ${personLabel(person)}: ${money(row.amortization)} per 16–end payslip from ${row.start_period}${row.reference_no ? `, ref. ${row.reference_no}` : ""} (by ${row.created_by_name}).`,
      metadata: { ...row },
    });
    return NextResponse.json({ success: true, id: saved.data?.id || null });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "government_loans", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const found = await supabase.from("payroll_loans").select(COLUMNS).eq("id", normalizeText(body.id)).maybeSingle();
    const loan = found.data;
    if (!loan || !GOVERNMENT_LOAN_TYPES.includes(loan.loan_type)) return NextResponse.json({ error: "Government loan not found." }, { status: 404 });
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const person = staff.find((p) => p.id === loan.employee_id) || null;
    const refused = await refusal(supabase, guard, person);
    if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
    const action = normalizeText(body.action);
    const reason = normalizeText(body.reason).slice(0, 300);
    if (reason.length < 5) return NextResponse.json({ error: "Give the reason (at least 5 characters)." }, { status: 400 });
    if (loan.status === "paid") return NextResponse.json({ error: "This loan is fully paid: nothing to change." }, { status: 409 });
    const by = actorName(guard);
    const now = new Date().toISOString();
    let update;
    let words;
    if (action === "edit") {
      update = {};
      if (body.amortization !== undefined && body.amortization !== "") {
        const a = Number(body.amortization);
        if (!(a > 0) || a > Number(loan.principal)) return NextResponse.json({ error: "The amount per payroll is more than 0 and at most the total." }, { status: 400 });
        update.amortization = peso(a);
      }
      if (body.reference_no !== undefined) {
        const ref = normalizeText(body.reference_no);
        if (ref && !/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,39}$/.test(ref)) return NextResponse.json({ error: "The reference number takes letters, numbers, spaces, dots, dashes and slashes (up to 40)." }, { status: 400 });
        update.reference_no = ref || null;
      }
      if (body.notes !== undefined) update.notes = normalizeText(body.notes).slice(0, 500) || null;
      if (!Object.keys(update).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
      words = `edited (${Object.entries(update).map(([k, v]) => `${k} ${k === "amortization" ? `${money(loan.amortization)} → ${money(v)}` : `→ ${v ?? "none"}`}`).join("; ")}); from the next payslip computed`;
    } else if (action === "suspend" || action === "end") {
      if (loan.status === "suspended" && action === "suspend") return NextResponse.json({ error: "Already suspended." }, { status: 409 });
      update = { status: "suspended", status_reason: `${action === "end" ? "Ended" : "Suspended"}: ${reason}`, status_changed_by: guard.userId, status_changed_by_name: by, status_changed_at: now };
      words = action === "end" ? "ended (no more deductions)" : "suspended";
    } else if (action === "resume") {
      if (loan.status !== "suspended") return NextResponse.json({ error: "Only a suspended loan can be resumed." }, { status: 409 });
      update = { status: "active", status_reason: `Resumed: ${reason}`, status_changed_by: guard.userId, status_changed_by_name: by, status_changed_at: now };
      words = "resumed";
    } else {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const saved = await supabase.from("payroll_loans").update(update).eq("id", loan.id);
    if (saved.error) return dbError(saved.error, "The change was not saved.");
    await appendAuditLog({
      actor: guard, module: "payroll", action: `government_loan_${action}`, entity_type: "payroll_loan", entity_id: loan.id, status: "success", source: "api",
      description: `${deductionLabel(loan)} of ${personLabel(person)} ${words} by ${by}: ${reason}.`,
      metadata: { before: Object.fromEntries(Object.keys(update).map((k) => [k, loan[k] ?? null])), after: update, reason },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
