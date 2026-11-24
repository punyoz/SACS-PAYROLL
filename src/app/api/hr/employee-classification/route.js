/**
 * An employee's category, employment status and type (Part A, 20261121010000).
 *
 *   GET  ?employee_id=          current values, the dated history, this year's leave credits
 *   POST { employee_id, changes: { field: value, ... }, effective_on, reason }
 *        record dated changes (applied at once when the date is today or past,
 *        else on the date by the nightly job); HR / Super Admin only
 *   POST { action: "confirm", employee_id, remark? }      HR confirms a "Needs HR confirmation" record
 *   POST { action: "override", employee_id, leave_type, year, days, reason }   per-employee leave credits
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { invalidateUsersCache } from "@/lib/auth/users-cache";
import { refuseOwnItem } from "@/lib/rbac/routing";
import {
  CATEGORY_OPTIONS, CLASSIFICATION_FIELDS, CREDIT_LEAVE_TYPES, EMPLOYMENT_STATUS_OPTIONS, EMPLOYMENT_TYPE_OPTIONS,
  FIELD_LABELS, classificationLabel, classificationOn, payRuleFor,
} from "@/lib/employees/classification";
import { leaveBalances, loadClassificationContext, loadPayRules, recordClassificationChange } from "@/lib/employees/classification-server";
import { conversionPreviewFor } from "@/lib/payroll/leave-conversion-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const actorName = (guard) => normalizeText(guard.session?.full_name, guard.session?.email);

async function guardWriter(request) {
  const guard = await requirePermission(request, "user_management", "update");
  if (guard.denied) return { denied: guard.denied };
  if (!["hr", "super_admin"].includes(guard.role)) {
    return { denied: NextResponse.json({ error: "Only HR or the Super Admin changes an employee's status." }, { status: 403 }) };
  }
  return { guard };
}

/** Why a value cannot be used for a field, or null. */
function valueError(field, value, hiredOn) {
  if (field === "employee_type") return CATEGORY_OPTIONS.includes(value) ? null : "Choose Teaching or Non-Teaching.";
  if (field === "employment_status") return EMPLOYMENT_STATUS_OPTIONS.includes(value) ? null : "Choose Regular, Probationary, Provisional or Contractual.";
  if (field === "employment_type") return EMPLOYMENT_TYPE_OPTIONS.includes(value) ? null : "Everyone is Full-time.";
  if (field === "on_payroll") return typeof value === "boolean" ? null : "Choose on or off payroll.";
  if (field === "contract_end_date") {
    if (value === null || value === "") return null;
    if (!DATE.test(String(value))) return "Contract end date must be a date.";
    if (hiredOn && value < hiredOn) return "Contract end date must be on or after the date hired.";
    return null;
  }
  return "Unknown field.";
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "user_management", "read");
    if (guard.denied) return guard.denied;
    const id = new URL(request.url).searchParams.get("employee_id");
    if (!UUID.test(String(id || ""))) return NextResponse.json({ error: "Choose an employee." }, { status: 400 });
    const supabase = getAdminClient();
    const { profiles, changes } = await loadClassificationContext(supabase, [id]);
    const profile = profiles.get(id);
    if (!profile) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    if (!guard.branchExempt && profile.branch_id !== guard.branchId) return NextResponse.json({ error: "That employee is in another branch." }, { status: 403 });
    const history = (changes.get(id) || []).sort((a, b) => String(b.effective_on).localeCompare(String(a.effective_on)) || String(b.created_at).localeCompare(String(a.created_at)));
    const year = Number(today().slice(0, 4));
    const [balances, payRules] = await Promise.all([leaveBalances(supabase, [id], year), loadPayRules(supabase)]);
    const now = classificationOn(profile, history, today());
    return NextResponse.json({
      current: { ...now, classification_unconfirmed: Boolean(profile.classification_unconfirmed), date_hired: profile.date_hired },
      history,
      leave: { year, ...(balances[id] || {}), conversion: await conversionPreviewFor(supabase, id, balances[id]) },
      pay_rule: payRuleFor(payRules, now, today()),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { guard, denied } = await guardWriter(request);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const id = String(body.employee_id || "");
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose an employee." }, { status: 400 });
    const supabase = getAdminClient();
    const { profiles } = await loadClassificationContext(supabase, [id]);
    const profile = profiles.get(id);
    if (!profile || !["employee", "accountant", "hr"].includes(String(profile.role).toLowerCase())) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }
    const who = profile.full_name || "the employee";
    // Never one's own record (the rule for every HR decision).
    if (id === guard.userId) {
      return refuseOwnItem(guard, { module: "employees", entityType: "employee", entityId: id, what: "employee record" });
    }

    if (body.action === "confirm") {
      if (!profile.classification_unconfirmed) return NextResponse.json({ error: "This record is already confirmed." }, { status: 409 });
      const remark = normalizeText(body.remark).slice(0, 300);
      const done = await supabase.from("profiles").update({ classification_unconfirmed: false, updated_at: new Date().toISOString() }).eq("id", id);
      if (done.error) return NextResponse.json({ error: sanitizeError(done.error) }, { status: 400 });
      await appendAuditLog({
        actor: guard, module: "employees", action: "classification_confirm", entity_type: "employee", entity_id: id,
        branch_id: profile.branch_id || null, status: "success", source: "api",
        description: `${who}: ${classificationLabel(profile)} confirmed by ${actorName(guard)}${remark ? ` (${remark})` : ""}.`,
        metadata: { employee_type: profile.employee_type, employment_status: profile.employment_status, employment_type: profile.employment_type },
      });
      return NextResponse.json({ success: true });
    }

    if (body.action === "override") {
      const leaveType = String(body.leave_type || "");
      const year = Number(body.year);
      const days = Number(body.days);
      const reason = normalizeText(body.reason).slice(0, 500);
      if (!CREDIT_LEAVE_TYPES.includes(leaveType)) return NextResponse.json({ error: "Choose the leave type." }, { status: 400 });
      if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ error: "Choose the year." }, { status: 400 });
      if (!Number.isFinite(days) || days < 0 || days > 366 || Math.round(days * 2) !== days * 2) {
        return NextResponse.json({ error: "Days must be 0 to 366, in half days." }, { status: 400 });
      }
      if (reason.length < 5) return NextResponse.json({ error: "Give the reason (at least 5 characters)." }, { status: 400 });
      const added = await supabase.from("leave_credit_overrides").insert({
        employee_id: id, leave_type: leaveType, year, days, reason, created_by: guard.userId, created_by_name: actorName(guard),
      }).select("*").maybeSingle();
      if (added.error) return NextResponse.json({ error: sanitizeError(added.error) }, { status: 400 });
      await appendAuditLog({
        actor: guard, module: "employees", action: "leave_credit_override", entity_type: "employee", entity_id: id,
        branch_id: profile.branch_id || null, status: "success", source: "api",
        description: `${who}: ${leaveType} for ${year} set to ${days} day${days === 1 ? "" : "s"} (${reason}), by ${actorName(guard)}.`,
        metadata: { leave_type: leaveType, year, days, reason, override_id: added.data?.id || null },
      });
      return NextResponse.json({ success: true, override: added.data });
    }

    const effectiveOn = String(body.effective_on || "");
    const reason = normalizeText(body.reason).slice(0, 500);
    if (!DATE.test(effectiveOn)) return NextResponse.json({ error: "Choose the effective date." }, { status: 400 });
    if (profile.date_hired && effectiveOn < profile.date_hired) return NextResponse.json({ error: "The effective date must be on or after the date hired." }, { status: 400 });
    if (reason.length < 3) return NextResponse.json({ error: "Give the reason for the change." }, { status: 400 });
    const changes = Object.entries(body.changes || {}).filter(([field]) => CLASSIFICATION_FIELDS.includes(field));
    if (!changes.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    for (const [field, value] of changes) {
      const error = valueError(field, value, profile.date_hired);
      if (error) return NextResponse.json({ error }, { status: 400 });
    }
    // A Contractual employee needs a contract end date (in this change or already on record).
    const statusTo = changes.find(([f]) => f === "employment_status")?.[1];
    const endTo = changes.find(([f]) => f === "contract_end_date");
    if (statusTo === "Contractual" && !(endTo ? endTo[1] : profile.contract_end_date)) {
      return NextResponse.json({ error: "A Contractual employee needs a contract end date." }, { status: 400 });
    }

    const recorded = [];
    for (const [field, value] of changes) {
      const result = await recordClassificationChange(supabase, {
        employeeId: id, field, value, effectiveOn, reason, actor: { userId: guard.userId, name: actorName(guard) },
      });
      if (result.error && !result.change) {
        if (result.error === "That is already the value on that date.") continue;
        return NextResponse.json({ error: sanitizeError(result.error), recorded }, { status: 400 });
      }
      recorded.push(result.change);
      const label = FIELD_LABELS[field];
      const show = (v) => (field === "on_payroll" ? (v === "true" ? "on payroll" : "not on payroll") : v || "none");
      await appendAuditLog({
        actor: guard, module: "employees", action: "classification_change", entity_type: "employee", entity_id: id,
        branch_id: profile.branch_id || null, status: "success", source: "api",
        description: `${who}: ${label} ${show(result.change.old_value)} → ${show(result.change.new_value)} from ${effectiveOn} (${reason}), by ${actorName(guard)}.`,
        metadata: { field, old_value: result.change.old_value, new_value: result.change.new_value, effective_on: effectiveOn, reason, change_id: result.change.id },
      });
    }
    if (!recorded.length) return NextResponse.json({ error: "Those are already the values on that date." }, { status: 409 });
    invalidateUsersCache();
    return NextResponse.json({ success: true, recorded, applied_now: effectiveOn <= today() });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
