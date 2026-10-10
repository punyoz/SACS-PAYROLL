/**
 * Loans (docs/payroll-schedule-loans-awol.md §4, §6): the one loan system.
 *
 *   GET    loans in the caller's reach with their repayments, the people who
 *          can borrow, and open licensed-teacher subsidy balances (for advances)
 *   POST   { action: "create_loan", employee_id, loan_type, principal,
 *            interest_pct, number_of_payrolls, amortization, date_granted,
 *            start_period, description, final_pay_authorized }
 *          { action: "create_subsidy_advance", employee_id, subsidy_balance_id,
 *            principal, date_granted, description }
 *   PATCH  { action: "set_status", loan_id, status: active | suspended, reason }
 *          { action: "convert_excess", loan_id, amortization, number_of_payrolls,
 *            start_period, consent_signed: true }   excess subsidy advance → loan
 *          { action: "record_refusal", loan_id, reason }  consent refused (§6.7)
 *
 * Balances are kept by the database (payroll_loan_payments_apply); payroll
 * deducts on the 2nd half (src/lib/payroll/loans.js). Accountant: own branch;
 * Super Admin: all; Admin: view; Employee: own loans (read).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { manilaDateKey, periodForDateKey } from "@/lib/payroll/periods";
import { roundPeso } from "@/lib/payroll/money";
import {
  LOAN_TYPE_LABELS,
  nextSecondHalf,
  suggestedAmortization,
  totalPayable,
  validateLoanInput,
  validateSubsidyAdvanceInput,
} from "@/lib/payroll/loans";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";

const peso = (value) => roundPeso(value);
const NOT_READY = "Loans are not set up yet: apply 20261009010000_payslip_schedule_loans_awol_subsidy.sql.";

/** Database refusals (triggers / checks) carry a message meant for people. */
function dbError(error, fallback = "The loan was not saved.") {
  const code = String(error?.code || "");
  if (["P0001", "23514", "23505"].includes(code)) {
    return NextResponse.json({ error: String(error.message || fallback).replace(/^ERROR:\s*/, "") }, { status: 400 });
  }
  return NextResponse.json({ error: sanitizeError(error, fallback) }, { status: 500 });
}

function money(value) {
  return `₱${peso(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What a subsidy balance can still advance (mirrors payroll_loans_open). */
function advanceAvailable(balance, onDate) {
  let cap = peso(balance.remaining);
  if (balance.advance_limit === "earned_to_date") {
    const [y, m] = String(onDate).split("-").map(Number);
    const [ey, em] = String(balance.eligible_from).split("-").map(Number);
    const months = Math.max(0, (y * 12 + m) - (ey * 12 + em) + 1);
    cap = Math.min(cap, peso(Number(balance.annual_amount) * Math.min(months, balance.eligible_months) / 12
      - Number(balance.advances_total) - Number(balance.paid_out)));
  }
  return Math.max(0, peso(cap));
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "loans", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
    const byId = new Map(staff.map((person) => [person.id, person]));
    const ids = staff.map((person) => person.id);
    if (!ids.length) return NextResponse.json({ available: true, loans: [], people: [], subsidy_balances: [], summary: {} });

    const loanResult = await fetchAllRows(() => supabase.from("payroll_loans").select("*")
      .in("employee_id", ids).order("date_granted", { ascending: false }).order("id", { ascending: true }));
    if (loanResult.error) return NextResponse.json({ available: false, error: NOT_READY, loans: [] });
    const loanRows = loanResult.data || [];

    const paymentResult = loanRows.length
      ? await fetchAllRows(() => supabase.from("payroll_loan_payments")
        .select("id,loan_id,kind,period_start,pay_period,amount,amount_due,balance_after,reversed,note,created_at,created_by_name")
        .in("loan_id", loanRows.map((loan) => loan.id)).order("created_at", { ascending: true }).order("id", { ascending: true }))
      : { data: [], error: null };
    if (paymentResult.error) throw new Error(paymentResult.error.message);
    const paymentsByLoan = new Map();
    (paymentResult.data || []).forEach((row) => {
      const list = paymentsByLoan.get(row.loan_id) || [];
      list.push({ ...row, amount: peso(row.amount), amount_due: peso(row.amount_due) });
      paymentsByLoan.set(row.loan_id, list);
    });

    const loans = loanRows.map((loan) => {
      const person = byId.get(loan.employee_id);
      const payments = paymentsByLoan.get(loan.id) || [];
      const repaid = peso(payments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
      return {
        ...loan,
        principal: peso(loan.principal),
        total_payable: peso(loan.total_payable),
        amortization: loan.amortization === null ? null : peso(loan.amortization),
        remaining_balance: peso(loan.remaining_balance),
        repaid,
        type_label: LOAN_TYPE_LABELS[loan.loan_type] || loan.loan_type,
        employee_name: person?.full_name || "—",
        employee_code: person?.employee_id || "",
        payments,
      };
    });

    // Open subsidy balances of the licensed teachers in reach (for advances).
    let subsidyBalances = [];
    if (guard.scope !== "self") {
      const balanceResult = await supabase.from("payroll_subsidy_balances").select("*").in("employee_id", ids).eq("status", "open");
      if (!balanceResult.error) {
        const today = manilaDateKey();
        subsidyBalances = (balanceResult.data || []).map((balance) => ({
          ...balance,
          employee_name: byId.get(balance.employee_id)?.full_name || "—",
          available: advanceAvailable(balance, today),
        }));
      }
    }

    const open = loans.filter((loan) => loan.status !== "paid");
    return NextResponse.json({
      available: true,
      loans,
      people: guard.scope === "self" ? [] : staff.filter((person) => !person.archived).map((person) => ({
        id: person.id, full_name: person.full_name, employee_id: person.employee_id,
        payroll_hold: person.payroll_hold, is_licensed_teacher: person.is_licensed_teacher,
      })),
      subsidy_balances: subsidyBalances,
      summary: {
        open_count: open.length,
        outstanding: peso(open.reduce((sum, loan) => sum + loan.remaining_balance, 0)),
        repaid: peso(loans.reduce((sum, loan) => sum + loan.repaid, 0)),
        awaiting_decision: loans.filter((loan) => loan.awaiting_decision).length,
      },
      can_edit: guard.role === "accountant" || guard.role === "super_admin",
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

async function findPerson(supabase, guard, employeeId) {
  const staff = await loadPayrollStaff(supabase, guard);
  return staff.find((person) => person.id === normalizeText(employeeId)) || null;
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "loans", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    const supabase = getAdminClient();

    const person = await findPerson(supabase, guard, body.employee_id);
    if (!person) return NextResponse.json({ error: "Employee not found in your branch." }, { status: 404 });
    if (person.id === guard.userId) return NextResponse.json({ error: "You cannot record a loan for yourself." }, { status: 403 });

    if (action === "create_loan") {
      const input = {
        loan_type: normalizeText(body.loan_type),
        principal: body.principal,
        interest_pct: body.interest_pct === "" || body.interest_pct === undefined ? 0 : body.interest_pct,
        number_of_payrolls: Number(body.number_of_payrolls),
        amortization: body.amortization === "" || body.amortization === undefined
          ? suggestedAmortization(totalPayable(body.principal, body.interest_pct || 0), body.number_of_payrolls)
          : body.amortization,
        date_granted: normalizeText(body.date_granted),
        start_period: normalizeText(body.start_period),
      };
      const invalid = validateLoanInput(input);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      // This month's 16–end payslip or a later one, and not one already Final.
      if (input.start_period < `${manilaDateKey().slice(0, 7)}-16`) {
        return NextResponse.json({ error: "The first deduction must be this month's 16–end payslip or a later one." }, { status: 400 });
      }
      const startLabel = periodForDateKey(input.start_period).label;
      const finalExists = await supabase.from("payroll_entries").select("id")
        .eq("employee_id", person.id).eq("pay_period", startLabel).eq("status", "paid").maybeSingle();
      if (finalExists.data) {
        return NextResponse.json({ error: `${person.full_name}'s ${startLabel} payslip is already Final. Start the deduction on a later pay period.` }, { status: 409 });
      }

      const row = {
        employee_id: person.id,
        branch_id: person.branch_id || null,
        loan_type: input.loan_type,
        description: normalizeText(body.description).slice(0, 200) || null,
        date_granted: input.date_granted,
        principal: peso(input.principal),
        interest_pct: Number(input.interest_pct) || 0,
        number_of_payrolls: input.number_of_payrolls,
        amortization: peso(input.amortization),
        start_period: input.start_period,
        final_pay_authorized: body.final_pay_authorized !== false,
        created_by: guard.userId || null,
        created_by_name: actorName(guard),
      };
      const result = await supabase.from("payroll_loans").insert(row).select("id,total_payable").maybeSingle();
      if (result.error) return dbError(result.error);

      await appendAuditLog({
        actor: guard, module: "payroll", action: "loan_create", entity_type: "payroll_loan",
        entity_id: result.data?.id || person.id, status: "success", source: "api",
        description: `${LOAN_TYPE_LABELS[row.loan_type]} ${money(row.principal)} for ${personLabel(person)}: ${money(row.amortization)} per 16–end payslip from ${row.start_period}.`,
        metadata: row,
      });
      return NextResponse.json({ success: true, id: result.data?.id || null, total_payable: result.data?.total_payable ?? totalPayable(row.principal, row.interest_pct) });
    }

    if (action === "create_subsidy_advance") {
      const balanceResult = await supabase.from("payroll_subsidy_balances").select("*")
        .eq("id", normalizeText(body.subsidy_balance_id)).maybeSingle();
      if (balanceResult.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
      const balance = balanceResult.data;
      if (!balance || balance.employee_id !== person.id || balance.status !== "open") {
        return NextResponse.json({ error: "No open subsidy balance for this teacher." }, { status: 404 });
      }
      const dateGranted = normalizeText(body.date_granted, manilaDateKey());
      const invalid = validateSubsidyAdvanceInput({ principal: body.principal, date_granted: dateGranted }, advanceAvailable(balance, dateGranted));
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

      const row = {
        employee_id: person.id,
        branch_id: person.branch_id || null,
        loan_type: "subsidy_advance",
        description: normalizeText(body.description).slice(0, 200) || `Subsidy advance ${String(balance.subsidy_year_start).slice(0, 4)}`,
        date_granted: dateGranted,
        principal: peso(body.principal),
        subsidy_balance_id: balance.id,
        final_pay_authorized: body.final_pay_authorized !== false,
        created_by: guard.userId || null,
        created_by_name: actorName(guard),
      };
      const result = await supabase.from("payroll_loans").insert(row).select("id").maybeSingle();
      if (result.error) return dbError(result.error, "The advance was not saved.");

      await appendAuditLog({
        actor: guard, module: "payroll", action: "subsidy_advance", entity_type: "payroll_loan",
        entity_id: result.data?.id || person.id, status: "success", source: "api",
        description: `Licensed teacher subsidy advance ${money(row.principal)} for ${personLabel(person)} (not deducted from salary).`,
        metadata: row,
      });
      return NextResponse.json({ success: true, id: result.data?.id || null });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "loans", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    const supabase = getAdminClient();

    const found = await supabase.from("payroll_loans").select("*").eq("id", normalizeText(body.loan_id)).maybeSingle();
    if (found.error) return NextResponse.json({ error: NOT_READY }, { status: 503 });
    const loan = found.data;
    if (!loan) return NextResponse.json({ error: "Loan not found." }, { status: 404 });
    const person = await findPerson(supabase, guard, loan.employee_id);
    if (!person) return NextResponse.json({ error: "That loan belongs to another branch." }, { status: 403 });
    if (person.id === guard.userId) return NextResponse.json({ error: "You cannot change your own loan." }, { status: 403 });
    const reason = normalizeText(body.reason).slice(0, 300);
    const now = new Date().toISOString();

    if (action === "set_status") {
      const status = normalizeText(body.status).toLowerCase();
      if (!["active", "suspended"].includes(status)) return NextResponse.json({ error: "Status must be active or suspended." }, { status: 400 });
      if (loan.status === "paid") return NextResponse.json({ error: "A paid loan cannot be changed." }, { status: 409 });
      if (loan.awaiting_decision) return NextResponse.json({ error: "This advance waits for an HR / Admin decision (Approvals)." }, { status: 409 });
      if (status === "suspended" && reason.length < 5) return NextResponse.json({ error: "Give a reason for suspending (at least 5 characters)." }, { status: 400 });
      const result = await supabase.from("payroll_loans").update({
        status, status_reason: reason || null, status_changed_by: guard.userId || null,
        status_changed_by_name: actorName(guard), status_changed_at: now,
      }).eq("id", loan.id);
      if (result.error) return dbError(result.error);
      await appendAuditLog({
        actor: guard, module: "payroll", action: "loan_status", entity_type: "payroll_loan", entity_id: loan.id,
        status: "success", source: "api",
        description: `Loan ${money(loan.principal)} for ${personLabel(person)} ${status === "suspended" ? "suspended" : "resumed"}${reason ? `: ${reason}` : ""}.`,
        metadata: { from: loan.status, to: status, reason: reason || null },
      });
      return NextResponse.json({ success: true });
    }

    if (action === "record_refusal" || action === "convert_excess") {
      if (loan.loan_type !== "subsidy_advance" || loan.status === "paid" || Number(loan.remaining_balance) <= 0) {
        return NextResponse.json({ error: "Only an unpaid subsidy advance has an excess to settle." }, { status: 409 });
      }
      const balance = await supabase.from("payroll_subsidy_balances").select("*").eq("id", loan.subsidy_balance_id).maybeSingle();
      // The excess is what the advances exceed the entitlement by (§6.4).
      const excess = balance.data ? Math.max(0, peso(-Number(balance.data.remaining))) : 0;
      if (excess <= 0) return NextResponse.json({ error: "This advance is still covered by the teacher's subsidy: nothing to settle." }, { status: 409 });
      const settle = Math.min(excess, peso(loan.remaining_balance));

      if (action === "record_refusal") {
        if (reason.length < 5) return NextResponse.json({ error: "Record what the teacher said (at least 5 characters)." }, { status: 400 });
        const result = await supabase.from("payroll_loans").update({
          status: "suspended", awaiting_decision: true, consent_refused_at: now,
          status_reason: `Consent refused: ${reason}`, status_changed_by: guard.userId || null,
          status_changed_by_name: actorName(guard), status_changed_at: now,
        }).eq("id", loan.id);
        if (result.error) return dbError(result.error);
        await appendAuditLog({
          actor: guard, module: "payroll", action: "subsidy_excess_refused", entity_type: "payroll_loan", entity_id: loan.id,
          status: "success", source: "api",
          description: `${personLabel(person)} refused to sign for the ${money(settle)} excess subsidy advance; sent to HR and Admin. Nothing is deducted meanwhile.`,
          metadata: { excess: settle, reason },
        });
        return NextResponse.json({ success: true, excess: settle });
      }

      // convert_excess: the teacher signed — a regular cash advance repaid on 2nd halves.
      if (body.consent_signed !== true) return NextResponse.json({ error: "The teacher's signed consent is required to deduct from salary." }, { status: 400 });
      const payrolls = Number(body.number_of_payrolls) || 1;
      const amortization = body.amortization ? peso(body.amortization) : suggestedAmortization(settle, payrolls);
      const input = {
        loan_type: "cash_advance", principal: settle, interest_pct: 0, number_of_payrolls: payrolls, amortization,
        date_granted: manilaDateKey(), start_period: normalizeText(body.start_period, nextSecondHalf(manilaDateKey())),
      };
      const invalid = validateLoanInput(input);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      const created = await supabase.from("payroll_loans").insert({
        employee_id: person.id, branch_id: person.branch_id || null, loan_type: "cash_advance",
        description: `Excess subsidy advance (signed consent)`, date_granted: input.date_granted, principal: settle,
        interest_pct: 0, number_of_payrolls: payrolls, amortization, start_period: input.start_period,
        final_pay_authorized: true, created_by: guard.userId || null, created_by_name: actorName(guard),
      }).select("id").maybeSingle();
      if (created.error) return dbError(created.error);
      const linked = await supabase.from("payroll_loans").update({ converted_to_loan_id: created.data.id, awaiting_decision: false }).eq("id", loan.id);
      if (linked.error) return dbError(linked.error);
      const paid = await supabase.from("payroll_loan_payments").insert({
        loan_id: loan.id, employee_id: person.id, kind: "converted", amount: settle, amount_due: settle,
        note: "Converted to a cash advance with the teacher's signed consent",
        created_by: guard.userId || null, created_by_name: actorName(guard),
      });
      if (paid.error) return dbError(paid.error);
      await appendAuditLog({
        actor: guard, module: "payroll", action: "subsidy_excess_converted", entity_type: "payroll_loan", entity_id: loan.id,
        status: "success", source: "api",
        description: `${money(settle)} excess subsidy advance of ${personLabel(person)} converted to a cash advance, ${money(amortization)} per 16–end payslip (signed consent).`,
        metadata: { new_loan_id: created.data.id, excess: settle, amortization, payrolls },
      });
      return NextResponse.json({ success: true, new_loan_id: created.data.id });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
