/**
 * Tenure Pay Protection (HR → Tenure Pay Protection; Admin and Super Admin
 * have the same page; supabase/migrations/20261015010000_tenure_pay_protection.sql).
 *
 *   GET   the policy (system-wide and per branch), the summer / Christmas
 *         break dates, every employee with their tenure, whether they MEET
 *         the threshold and whether they HAVE the benefit granted, and the
 *         grant history with the payslips each grant has protected.
 *         Super Admin and HR see every branch, Admin its own.
 *
 *   POST  ("create" on tenure_protection: Super Admin, HR, Admin. Accountant
 *         and Employee get 403 here, whatever their screen shows.)
 *     { action: "save_policy", branch_id|null, min_tenure_years, categories, is_active, use_global }
 *         branch_id null = the system-wide policy (Super Admin / HR only);
 *         a branch's own policy: Admin only for its own branch.
 *     { action: "save_break", school_year, kind, start_date, end_date, note }
 *     { action: "archive_break", school_year, kind }       Super Admin / HR only
 *     { action: "grant", employee_id, effective_from, notes }
 *         today or later; the employee must have the minimum tenure by then.
 *     { action: "revoke", grant_id, revoked_on, notes }
 *         today or later: payroll before that date keeps the protection.
 *
 * Every change is written to Audit & Monitoring (who, their role, what, when).
 * The database refuses a grant, policy or break written by anyone who is not
 * HR, Admin or Super Admin, and never lets a grant be edited or deleted.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { isDateKey, manilaDateKey } from "@/lib/payroll/periods";
import { actorName } from "@/lib/payroll/staff";
import {
  BREAK_KINDS,
  breaksOverlap,
  eligibleFrom,
  grantOn,
  meetsTenure,
  openGrant,
  policyFor,
  PROTECTION_CATEGORIES,
  schoolYearOf,
  schoolYearOptions,
  shapePolicy,
  tenureYears,
  validateBreakInput,
  validatePolicyInput,
} from "@/lib/payroll/tenure-protection";
import { isMissingTable, loadTenureProtection, TENURE_NOT_READY } from "@/lib/payroll/tenure-protection-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID_ROLES = ["employee", "accountant"];
const ROLE_LABELS = { super_admin: "Super Admin", admin: "Admin", hr: "HR" };

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today or later (Manila), within a year. */
function checkFutureDate(value, what) {
  const today = manilaDateKey();
  const key = normalizeText(value) || today;
  if (!isDateKey(key)) return { error: `Choose the date ${what}.` };
  if (key < today) return { error: `The date ${what} cannot be before today: payroll already worked out is never recalculated.` };
  if (key > addDays(today, 366)) return { error: "Choose a date within the next year." };
  return { key };
}

function byWhom(guard) {
  return `by ${actorName(guard) || "unknown"} (${ROLE_LABELS[guard.role] || guard.role})`;
}

function audit(guard, action, description, metadata, entityType, entityId) {
  return appendAuditLog({
    actor: guard,
    module: "tenure_protection",
    action,
    entity_type: entityType,
    entity_id: entityId || null,
    description: `${description.replace(/\.$/, "")}, ${byWhom(guard)}.`,
    status: "success",
    source: "api",
    metadata: { ...metadata, changed_by_role: guard.role, changed_by_name: actorName(guard) },
  });
}

async function loadBranches(supabase, guard) {
  let query = supabase.from("branches").select("id,name");
  if (!guard.branchExempt) query = query.eq("id", guard.branchId);
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return (result.data || []).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

async function loadEmployees(supabase, guard) {
  const result = await fetchAllRows(() => {
    let query = supabase.from("profiles")
      .select("id,full_name,employee_id,branch_id,position,date_hired,role,archived,employee_status")
      .in("role", PAID_ROLES)
      .eq("archived", false);
    if (!guard.branchExempt) query = query.eq("branch_id", guard.branchId);
    return query.order("full_name", { ascending: true }).order("id", { ascending: true });
  });
  if (result.error) throw new Error(result.error.message);
  return (result.data || []).filter((row) => String(row.employee_status || "active").toLowerCase() !== "inactive");
}

/** Per grant: how many deductions it waived, how much, on which payslips. */
async function loadApplications(supabase, grantIds) {
  if (!grantIds.length) return new Map();
  const result = await fetchAllIn(() => supabase.from("tenure_protection_applications")
    .select("grant_id,pay_period,amount,category,created_at")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true }), "grant_id", grantIds);
  if (!result.error) result.data.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  if (result.error) {
    if (isMissingTable(result.error)) return new Map();
    throw new Error(result.error.message);
  }
  const byGrant = new Map();
  (result.data || []).forEach((row) => {
    const entry = byGrant.get(row.grant_id) || { count: 0, total: 0, pay_periods: [] };
    entry.count += 1;
    entry.total = Math.round((entry.total + (Number(row.amount) || 0)) * 100) / 100;
    if (!entry.pay_periods.includes(row.pay_period)) entry.pay_periods.push(row.pay_period);
    byGrant.set(row.grant_id, entry);
  });
  return byGrant;
}

function shapeGrant(row, names, applied) {
  if (!row) return null;
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: names.get(row.employee_id) || null,
    effective_from: String(row.effective_from).slice(0, 10),
    notes: row.notes || null,
    granted_by_name: row.granted_by_name || null,
    granted_by_role: row.granted_by_role || null,
    granted_at: row.granted_at || null,
    revoked_on: row.revoked_on ? String(row.revoked_on).slice(0, 10) : null,
    revoked_by_name: row.revoked_by_name || null,
    revoked_by_role: row.revoked_by_role || null,
    revoked_at: row.revoked_at || null,
    revoke_notes: row.revoke_notes || null,
    applied: applied?.get(row.id) || { count: 0, total: 0, pay_periods: [] },
  };
}

function shapeBreak(row) {
  return {
    id: row.id,
    school_year: row.school_year,
    kind: row.kind,
    label: BREAK_KINDS.find((k) => k.key === row.kind)?.label || row.kind,
    start_date: String(row.start_date).slice(0, 10),
    end_date: String(row.end_date).slice(0, 10),
    archived: row.archived === true,
    note: row.note || null,
    updated_by_name: row.updated_by_name || row.created_by_name || null,
    updated_at: row.updated_at || row.created_at || null,
  };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "tenure_protection", "read");
    if (guard.denied) return guard.denied;

    const supabase = getAdminClient();
    const data = await loadTenureProtection(supabase);
    if (!data.available) return NextResponse.json({ available: false, error: TENURE_NOT_READY });

    const today = manilaDateKey();
    const [branches, employees] = await Promise.all([loadBranches(supabase, guard), loadEmployees(supabase, guard)]);
    const branchName = new Map(branches.map((b) => [String(b.id), b.name]));
    const visibleIds = new Set(employees.map((e) => e.id));
    const names = new Map(employees.map((e) => [e.id, e.full_name]));
    const grants = data.grants.filter((g) => visibleIds.has(g.employee_id));
    const applied = await loadApplications(supabase, grants.map((g) => g.id));

    const systemRow = data.policies.find((row) => !row.branch_id) || null;
    const branchPolicies = branches.map((branch) => {
      const own = data.policies.find((row) => row.branch_id && String(row.branch_id) === String(branch.id)) || null;
      const effective = policyFor(data.policies, branch.id);
      return {
        branch_id: branch.id,
        branch_name: branch.name,
        has_own: Boolean(own) && own.use_global !== true,
        own: own ? shapePolicy(own) : null,
        effective,
      };
    });

    const rows = employees.map((row) => {
      const policy = policyFor(data.policies, row.branch_id);
      const open = openGrant(grants, row.id);
      const current = grantOn(grants, row.id, today);
      const meets = meetsTenure(row.date_hired, today, policy.min_tenure_years);
      return {
        id: row.id,
        full_name: row.full_name,
        employee_code: row.employee_id || null,
        position: row.position || null,
        role: row.role,
        branch_id: row.branch_id || null,
        branch_name: branchName.get(String(row.branch_id)) || null,
        date_hired: row.date_hired ? String(row.date_hired).slice(0, 10) : null,
        tenure_years: tenureYears(row.date_hired, today),
        min_tenure_years: policy.min_tenure_years,
        policy_source: policy.source,
        policy_active: policy.is_active,
        meets_tenure: meets,
        eligible_from: eligibleFrom(row.date_hired, policy.min_tenure_years),
        grant: shapeGrant(open || null, names, applied),
        // Protected today: granted, in force, tenure met, policy on.
        protected_today: Boolean(current) && meets && policy.is_active,
        grant_count: grants.filter((g) => g.employee_id === row.id).length,
      };
    });

    return NextResponse.json({
      available: true,
      today,
      school_year: schoolYearOf(today),
      school_years: schoolYearOptions(today),
      categories: PROTECTION_CATEGORIES.map(({ key, label }) => ({ key, label })),
      break_kinds: BREAK_KINDS.map(({ key, label }) => ({ key, label })),
      can_edit: ["super_admin", "hr", "admin"].includes(guard.role),
      can_edit_system: guard.branchExempt && ["super_admin", "hr"].includes(guard.role),
      branch_scoped: !guard.branchExempt,
      branches,
      policy: {
        system: { ...shapePolicy(systemRow), source: systemRow ? "system" : "default" },
        branches: branchPolicies,
      },
      breaks: data.breaks.map(shapeBreak),
      employees: rows,
      grants: grants.map((g) => shapeGrant(g, names, applied)),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/** Only Super Admin and HR (scope all) touch the system-wide settings. */
function refuseSystemWide(guard) {
  if (guard.branchExempt && ["super_admin", "hr"].includes(guard.role)) return null;
  return NextResponse.json({ error: "Only HR or the Super Admin can change the system-wide policy and the break dates." }, { status: 403 });
}

async function savePolicy(supabase, guard, body, data) {
  const branchId = body.branch_id ? normalizeText(body.branch_id) : null;
  if (!branchId) {
    const refused = refuseSystemWide(guard);
    if (refused) return refused;
  } else {
    if (!UUID.test(branchId)) return NextResponse.json({ error: "Unknown branch." }, { status: 400 });
    if (!guard.branchExempt && branchId !== String(guard.branchId || "")) {
      return NextResponse.json({ error: "You can only change your own branch's policy." }, { status: 403 });
    }
    const branch = await supabase.from("branches").select("id,name").eq("id", branchId).maybeSingle();
    if (branch.error) throw new Error(branch.error.message);
    if (!branch.data) return NextResponse.json({ error: "Unknown branch." }, { status: 404 });
  }

  const existing = data.policies.find((row) => (branchId ? String(row.branch_id || "") === branchId : !row.branch_id)) || null;
  const useGlobal = Boolean(branchId) && body.use_global === true;
  let value = {};
  if (!useGlobal) {
    const checked = validatePolicyInput(body);
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400 });
    value = checked.value;
  } else if (!existing) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  const row = {
    ...value,
    use_global: useGlobal,
    updated_by: guard.userId || null,
    updated_by_name: actorName(guard),
    updated_by_role: guard.role,
  };
  const result = existing
    ? await supabase.from("tenure_protection_policies").update(row).eq("id", existing.id).select("*").single()
    : await supabase.from("tenure_protection_policies").insert({ ...row, branch_id: branchId }).select("*").single();
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });

  const after = shapePolicy(result.data);
  const covered = PROTECTION_CATEGORIES.filter((c) => after.categories[c.key]).map((c) => c.label).join(", ") || "nothing";
  const where = branchId ? "Branch policy" : "System-wide policy";
  await audit(guard, useGlobal ? "policy_use_global" : "policy_update",
    useGlobal
      ? "Branch policy set back to follow the system-wide Tenure Pay Protection policy"
      : `${where} for Tenure Pay Protection saved: ${after.is_active ? "active" : "inactive"}, at least ${after.min_tenure_years} years, covers ${covered}`,
    { branch_id: branchId, before: existing ? shapePolicy(existing) : null, after }, "tenure_protection_policy", result.data.id);
  return NextResponse.json({ success: true, policy: after });
}

async function saveBreak(supabase, guard, body, data) {
  const refused = refuseSystemWide(guard);
  if (refused) return refused;
  const { value, error } = validateBreakInput(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const existing = data.breaks.find((row) => row.school_year === value.school_year && row.kind === value.kind) || null;
  const clash = data.breaks.find((row) => row.archived !== true && row.id !== existing?.id && breaksOverlap(row, value));
  if (clash) {
    return NextResponse.json({ error: `These dates overlap the ${clash.school_year} ${BREAK_KINDS.find((k) => k.key === clash.kind)?.label.toLowerCase() || "break"} (${String(clash.start_date).slice(0, 10)} – ${String(clash.end_date).slice(0, 10)}).` }, { status: 409 });
  }

  const row = {
    ...value,
    archived: false,
    updated_by: guard.userId || null,
    updated_by_name: actorName(guard),
    updated_by_role: guard.role,
  };
  const result = existing
    ? await supabase.from("school_break_periods").update(row).eq("id", existing.id).select("*").single()
    : await supabase.from("school_break_periods").insert({ ...row, created_by: guard.userId || null, created_by_name: actorName(guard) }).select("*").single();
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });

  const after = shapeBreak(result.data);
  await audit(guard, existing ? "break_update" : "break_create",
    `${after.label} ${after.school_year} set to ${after.start_date} – ${after.end_date}`,
    { before: existing ? shapeBreak(existing) : null, after }, "school_break_period", result.data.id);
  return NextResponse.json({ success: true, break: after });
}

async function archiveBreak(supabase, guard, body, data) {
  const refused = refuseSystemWide(guard);
  if (refused) return refused;
  const existing = data.breaks.find((row) => row.school_year === normalizeText(body.school_year) && row.kind === normalizeText(body.kind) && row.archived !== true);
  if (!existing) return NextResponse.json({ error: "That break is not set." }, { status: 404 });
  const result = await supabase.from("school_break_periods").update({
    archived: true,
    updated_by: guard.userId || null,
    updated_by_name: actorName(guard),
    updated_by_role: guard.role,
  }).eq("id", existing.id).select("*").single();
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
  const before = shapeBreak(existing);
  await audit(guard, "break_remove", `${before.label} ${before.school_year} (${before.start_date} – ${before.end_date}) removed`,
    { before }, "school_break_period", existing.id);
  return NextResponse.json({ success: true });
}

/** The employee if this caller may act on them. */
async function scopedEmployee(supabase, guard, employeeId) {
  if (!UUID.test(employeeId)) return { error: NextResponse.json({ error: "Choose an employee." }, { status: 400 }) };
  const result = await supabase.from("profiles")
    .select("id,full_name,branch_id,date_hired,role,archived,employee_status")
    .eq("id", employeeId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const employee = result.data;
  if (!employee || !PAID_ROLES.includes(String(employee.role || "").toLowerCase())) {
    return { error: NextResponse.json({ error: "Employee not found." }, { status: 404 }) };
  }
  if (!guard.branchExempt && String(employee.branch_id || "") !== String(guard.branchId || "")) {
    // Same answer as a missing employee: other branches are not disclosed.
    return { error: NextResponse.json({ error: "Employee not found." }, { status: 404 }) };
  }
  return { employee };
}

async function grant(supabase, guard, body, data) {
  const found = await scopedEmployee(supabase, guard, normalizeText(body.employee_id));
  if (found.error) return found.error;
  const { employee } = found;
  if (employee.archived === true) return NextResponse.json({ error: `${employee.full_name} is archived.` }, { status: 400 });

  const date = checkFutureDate(body.effective_from, "protection starts");
  if (date.error) return NextResponse.json({ error: date.error }, { status: 400 });
  if (openGrant(data.grants, employee.id)) {
    return NextResponse.json({ error: `${employee.full_name} already has Tenure Pay Protection granted. Revoke it first to grant it again.` }, { status: 409 });
  }

  const policy = policyFor(data.policies, employee.branch_id);
  if (!employee.date_hired) {
    return NextResponse.json({ error: `${employee.full_name} has no hire date on file, so their tenure cannot be checked. Add it in User Management first.` }, { status: 400 });
  }
  if (!meetsTenure(employee.date_hired, date.key, policy.min_tenure_years)) {
    return NextResponse.json({
      error: `${employee.full_name} does not meet the ${policy.min_tenure_years}-year tenure requirement on ${date.key}: eligible from ${eligibleFrom(employee.date_hired, policy.min_tenure_years)}.`,
    }, { status: 400 });
  }

  const notes = normalizeText(body.notes).slice(0, 500) || null;
  const result = await supabase.from("tenure_protection_grants").insert({
    employee_id: employee.id,
    effective_from: date.key,
    notes,
    granted_by: guard.userId,
    granted_by_name: actorName(guard),
    granted_by_role: guard.role,
  }).select("*").single();
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });

  await audit(guard, "grant", `Tenure Pay Protection granted to ${employee.full_name} from ${date.key}${notes ? ` (${notes})` : ""}`,
    { employee_id: employee.id, effective_from: date.key, notes, policy: { min_tenure_years: policy.min_tenure_years, source: policy.source, is_active: policy.is_active } },
    "tenure_protection_grant", result.data.id);
  return NextResponse.json({
    success: true,
    grant: shapeGrant(result.data, new Map([[employee.id, employee.full_name]]), null),
    ...(policy.is_active ? {} : { warning: "The policy for this employee's branch is switched off: payroll will not apply the protection until it is switched on." }),
  });
}

async function revoke(supabase, guard, body, data) {
  const grantId = normalizeText(body.grant_id);
  if (!UUID.test(grantId)) return NextResponse.json({ error: "Unknown grant." }, { status: 400 });
  const existing = data.grants.find((row) => row.id === grantId);
  if (!existing) return NextResponse.json({ error: "Unknown grant." }, { status: 404 });
  const found = await scopedEmployee(supabase, guard, existing.employee_id);
  if (found.error) return found.error;
  if (existing.revoked_on) return NextResponse.json({ error: "This grant is already revoked." }, { status: 409 });

  const date = checkFutureDate(body.revoked_on, "protection ends");
  if (date.error) return NextResponse.json({ error: date.error }, { status: 400 });
  // A grant that has not started yet simply never takes effect.
  const effective = String(existing.effective_from).slice(0, 10);
  const endsOn = date.key < effective ? effective : date.key;
  const notes = normalizeText(body.notes).slice(0, 500) || null;

  const result = await supabase.from("tenure_protection_grants").update({
    revoked_on: endsOn,
    revoked_by: guard.userId,
    revoked_by_name: actorName(guard),
    revoked_by_role: guard.role,
    revoked_at: new Date().toISOString(),
    revoke_notes: notes,
  }).eq("id", grantId).is("revoked_on", null).select("*").single();
  if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });

  await audit(guard, "revoke", `Tenure Pay Protection of ${found.employee.full_name} revoked from ${endsOn}${notes ? ` (${notes})` : ""}`,
    { employee_id: existing.employee_id, grant_id: grantId, effective_from: effective, revoked_on: endsOn, notes }, "tenure_protection_grant", grantId);
  return NextResponse.json({ success: true, revoked_on: endsOn });
}

export async function POST(request) {
  try {
    // "create" on tenure_protection: Super Admin, HR and Admin (permissions.js).
    const guard = await requirePermission(request, "tenure_protection", "create");
    if (guard.denied) return guard.denied;

    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action).toLowerCase();
    const supabase = getAdminClient();
    const data = await loadTenureProtection(supabase);
    if (!data.available) return NextResponse.json({ error: TENURE_NOT_READY }, { status: 503 });

    if (action === "save_policy") return await savePolicy(supabase, guard, body, data);
    if (action === "save_break") return await saveBreak(supabase, guard, body, data);
    if (action === "archive_break") return await archiveBreak(supabase, guard, body, data);
    if (action === "grant") return await grant(supabase, guard, body, data);
    if (action === "revoke") return await revoke(supabase, guard, body, data);
    return NextResponse.json({ error: "Action must be save_policy, save_break, archive_break, grant or revoke." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
