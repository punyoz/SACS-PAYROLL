import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyRoleEscalation, denyForeignBranch, scopeListToBranch } from "@/lib/rbac/guard";
import { normalizeEmployeeFields, validateEmployeeRecord } from "@/lib/employees/record";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAdminClient() {
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function toTitleCaseWords(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function composeFullName(record) {
  return [
    toTitleCaseWords(record.first_name),
    record.middle_initial,
    toTitleCaseWords(record.last_name),
    record.suffix,
  ].filter(Boolean).join(" ");
}

function shapeEmployee(user, profile) {
  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(meta.full_name, user.email)),
    employee_id: normalizeText(meta.employee_id),
    role: normalizeText(meta.role, "employee"),
    employee_type: normalizeText(meta.employee_type, "Teaching"),
    position: normalizeText(meta.position, "Employee"),
    employee_status: normalizeText(meta.employee_status, "Active"),
    employment_type: normalizeText(meta.employment_type),
    employment_status: normalizeText(meta.employment_status),
    sex: normalizeText(meta.sex),
    civil_status: normalizeText(meta.civil_status),
    date_of_birth: normalizeText(meta.date_of_birth),
    archived: Boolean(meta.archived),
    created_at: user.created_at,
    // profiles is authoritative for these (real, constrained columns —
    // see supabase/migrations/20260914010000_profile_id_fields_and_perf.sql);
    // metadata is only a fallback for a profile row not yet backfilled.
    address: normalizeText(profile?.address, normalizeText(meta.address, "")),
    sss_number: normalizeText(profile?.sss_number, normalizeText(meta.sss_number, "")),
    pagibig_number: normalizeText(profile?.pagibig_number, normalizeText(meta.pagibig_number, "")),
    philhealth_number: normalizeText(profile?.philhealth_number, normalizeText(meta.philhealth_number, "")),
    tin_number: normalizeText(meta.tin_number, ""),
    bank_name: normalizeText(profile?.bank_name, normalizeText(meta.bank_name, "")),
    bank_account_number: normalizeText(profile?.bank_account_number, normalizeText(meta.bank_account_number, "")),
    cp_number: normalizeText(profile?.cp_number, normalizeText(meta.cp_number, "")),
    date_hired: normalizeText(profile?.date_hired, normalizeText(meta.date_hired, "")),
    branch_id: profile?.branch_id || meta.branch_id || null,
  };
}

const MANAGED_ROLES = ["employee", "accountant"];

export async function GET(request) {
  const guard = await requirePermission(request, "employee_information", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("archived") === "true";

    const usersResult = await listUsersCached(supabase);
    if (usersResult.error) throw new Error(usersResult.error.message);

    const employeeUsers = (usersResult.data.users || []).filter((u) =>
      MANAGED_ROLES.includes(String(u.user_metadata?.role || "employee").toLowerCase()),
    );

    const userIds = employeeUsers.map((u) => u.id);
    const profileMap = new Map();

    if (userIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id,email,full_name,cp_number,date_hired,branch_id,address,sss_number,pagibig_number,philhealth_number,bank_name,bank_account_number")
        .in("id", userIds);
      (profiles || []).forEach((p) => profileMap.set(p.id, p));
    }

    let employees = employeeUsers.map((u) => shapeEmployee(u, profileMap.get(u.id)));

    if (!includeArchived) {
      employees = employees.filter((e) => !e.archived);
    }

    // HR reaches every branch here (SCOPE_ALL); anyone branch-scoped is filtered.
    employees = scopeListToBranch(employees, guard, (e) => e.branch_id);
    employees.sort((a, b) => a.full_name.localeCompare(b.full_name));

    return NextResponse.json({ employees, total: employees.length });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// HR can update an employee's identity, personal, employment, contact,
// government and bank details — but never role, basic salary or branch.
// Salary stays with the Accountant/Super Admin; branch moves go through
// Transfer Requests so every move is recorded.
export async function PATCH(request) {
  const guard = await requirePermission(request, "employee_information", "update");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);

    if (!id) {
      return NextResponse.json({ error: "Employee id is required." }, { status: 400 });
    }

    const { data: userData, error: fetchErr } = await supabase.auth.admin.getUserById(id);
    if (fetchErr || !userData?.user) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const currentMeta = userData.user.user_metadata || {};
    const currentRole = normalizeText(currentMeta.role, "employee").toLowerCase();

    const escalation = denyRoleEscalation(guard, currentRole);
    if (escalation) return escalation;

    const profileResult = await supabase
      .from("profiles")
      .select("branch_id")
      .eq("id", id)
      .maybeSingle();
    const targetBranch = profileResult.data?.branch_id || currentMeta.branch_id || null;
    if (!guard.branchExempt) {
      if (!targetBranch) {
        return NextResponse.json({ error: "That employee is not assigned to your branch." }, { status: 403 });
      }
      const foreign = denyForeignBranch(guard, targetBranch);
      if (foreign) return foreign;
    }

    const record = normalizeEmployeeFields(body);
    const invalid = validateEmployeeRecord(record, { creating: false });
    if (invalid) {
      return NextResponse.json({ error: invalid }, { status: 400 });
    }

    const fullName = composeFullName(record);

    const updatedMeta = {
      ...currentMeta,
      full_name: fullName,
      date_of_birth: record.date_of_birth,
      sex: record.sex,
      civil_status: record.civil_status,
      employee_type: record.employee_type,
      position: normalizeText(record.position, currentMeta.position || "Employee"),
      employment_type: record.employment_type,
      employment_status: record.employment_status,
      employee_status: record.employee_status,
      rfid_status: record.employee_status,
      address: record.address,
      cp_number: record.cp_number,
      date_hired: record.date_hired,
      sss_number: record.sss_number,
      philhealth_number: record.philhealth_number,
      pagibig_number: record.pagibig_number,
      tin_number: record.tin_number,
      bank_name: record.bank_name,
      bank_account_number: record.bank_account_number,
    };

    const updatePayload = { user_metadata: updatedMeta };
    if (record.email && record.email !== String(userData.user.email || "").toLowerCase()) {
      updatePayload.email = record.email;
    }

    const { error: updateErr } = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (updateErr) {
      return NextResponse.json({ error: sanitizeError(updateErr) }, { status: 400 });
    }

    invalidateUsersCache();

    // profiles is authoritative for these — every employee-listing route and
    // employee_info_view read them from there, not from user_metadata.
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({
        full_name: fullName,
        email: record.email,
        employee_type: record.employee_type,
        position: updatedMeta.position,
        employee_status: record.employee_status,
        cp_number: record.cp_number,
        date_hired: record.date_hired,
        address: record.address,
        sss_number: record.sss_number,
        pagibig_number: record.pagibig_number,
        philhealth_number: record.philhealth_number,
        bank_name: record.bank_name,
        bank_account_number: record.bank_account_number,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (profileErr) {
      return NextResponse.json(
        { error: `Account updated, but its profile record failed: ${sanitizeError(profileErr)}` },
        { status: 500 },
      );
    }

    await appendAuditLog({
      module: "employees",
      action: "update",
      entity_type: "employee",
      entity_id: normalizeText(currentMeta.employee_id, id),
      description: `Employee ${fullName} was updated by HR.`,
      status: "success",
      source: "api",
      metadata: { user_id: id, role: currentRole },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
