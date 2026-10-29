/**
 * Basic salary changes (decisions of 2026-10-26): HR only.
 *
 *   GET  ?employee_id=   the employee's salary on record, the one in force
 *                        now, and every change (who, when, old → new,
 *                        effective date, reason)
 *   POST { employee_id, new_salary, effective_date, reason, note? }
 *        records a change from the 1st of a month (this month or later, never
 *        a month whose 2nd half is already Final for the employee). Payroll
 *        uses it for periods from that date; past payslips never change.
 *
 * employee_information "update" (HR) and the HR role itself: the Super Admin,
 * Admin, Accountant and Employee get 403 here, and the database refuses a
 * change not made by an active HR account (20261027010000). The general
 * employee update no longer changes a salary (/api/admin/employees).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey, periodFromLabel } from "@/lib/payroll/periods";
import { roundPeso } from "@/lib/payroll/money";
import {
  SALARY_REASONS,
  applyDueSalaryChanges,
  dayBefore,
  loadSalaryChanges,
  salaryOn,
  shapeSalaryChange,
  validateSalaryChange,
} from "@/lib/employees/salary-history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID_ROLES = ["employee", "accountant"];
const money = (value) => `₱${roundPeso(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function guardHr(request) {
  const guard = await requirePermission(request, "employee_information", "update");
  if (guard.denied) return { denied: guard.denied };
  if (guard.role !== "hr") return { denied: NextResponse.json({ error: "Only HR changes an employee's salary." }, { status: 403 }) };
  return { guard };
}

async function findEmployee(supabase, id) {
  if (!UUID.test(String(id || ""))) return null;
  const result = await supabase.from("profiles").select("id,full_name,employee_id,role,archived,branch_id,basic_salary").eq("id", id).maybeSingle();
  const row = result.data;
  return row && PAID_ROLES.includes(String(row.role || "").toLowerCase()) ? row : null;
}

/** "YYYY-MM" months whose 2nd half is already Final for this employee. */
async function settledMonths(supabase, employeeId) {
  const result = await supabase.from("payroll_entries").select("pay_period,status").eq("employee_id", employeeId).eq("status", "paid");
  return (result.data || []).map((row) => periodFromLabel(row.pay_period)).filter((p) => p && p.start_key.slice(8) === "16").map((p) => p.start_key.slice(0, 7));
}

export async function GET(request) {
  const { guard, denied } = await guardHr(request);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const supabase = getAdminClient();
    const today = manilaDateKey();
    await applyDueSalaryChanges(supabase, today);
    const employee = await findEmployee(supabase, url.searchParams.get("employee_id"));
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    const history = await loadSalaryChanges(supabase, [employee.id]);
    return NextResponse.json({
      available: history.available,
      employee: { id: employee.id, full_name: employee.full_name, employee_id: employee.employee_id },
      on_record: roundPeso(employee.basic_salary),
      in_force: roundPeso(salaryOn(history.rows, employee.id, today, employee.basic_salary)),
      changes: history.rows.map(shapeSalaryChange).reverse(),
      reasons: SALARY_REASONS,
      can_edit: guard.role === "hr",
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const { guard, denied } = await guardHr(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const today = manilaDateKey();
    const employee = await findEmployee(supabase, normalizeText(body.employee_id));
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    if (employee.archived) return NextResponse.json({ error: "This employee is archived." }, { status: 409 });

    const input = {
      new_salary: body.new_salary,
      effective_date: normalizeText(body.effective_date),
      reason: normalizeText(body.reason),
      note: normalizeText(body.note),
    };
    const invalid = validateSalaryChange(input, { todayKey: today, settledMonths: await settledMonths(supabase, employee.id) });
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const history = await loadSalaryChanges(supabase, [employee.id]);
    if (!history.available) return NextResponse.json({ error: "Salary changes are not set up yet: apply 20261027010000_employee_salary_changes.sql." }, { status: 503 });
    // The salary it replaces: the one in force the day before it starts.
    const oldSalary = roundPeso(salaryOn(history.rows, employee.id, dayBefore(input.effective_date), employee.basic_salary));
    const newSalary = roundPeso(input.new_salary);
    if (newSalary === oldSalary) return NextResponse.json({ error: `The salary is already ${money(oldSalary)} then.` }, { status: 400 });

    const actorName = normalizeText(guard.session?.full_name, guard.session?.email);
    const inserted = await supabase.from("employee_salary_changes").insert({
      employee_id: employee.id,
      old_salary: oldSalary,
      new_salary: newSalary,
      effective_date: input.effective_date,
      reason: input.reason,
      note: input.note || null,
      created_by: guard.userId,
      created_by_name: actorName || null,
      created_by_role: guard.role,
    }).select("*").maybeSingle();
    if (inserted.error) return NextResponse.json({ error: sanitizeError(inserted.error) }, { status: 400 });

    // Starts this month: the salary on record changes now.
    const applied = input.effective_date <= today ? await applyDueSalaryChanges(supabase, today) : 0;
    await appendAuditLog({
      actor: guard,
      module: "employees",
      action: "salary_change",
      entity_type: "employee",
      entity_id: employee.employee_id || employee.id,
      branch_id: employee.branch_id || null,
      status: "success",
      source: "api",
      description: `Basic salary of ${employee.full_name}: ${money(oldSalary)} → ${money(newSalary)} from ${input.effective_date} (${input.reason}${input.note ? `: ${input.note}` : ""}), by ${actorName}.`,
      metadata: { user_id: employee.id, old_salary: oldSalary, new_salary: newSalary, effective_date: input.effective_date, reason: input.reason, note: input.note || null, change_id: inserted.data?.id || null },
    });
    return NextResponse.json({ success: true, change: inserted.data ? shapeSalaryChange(inserted.data) : null, applied_now: applied > 0 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
