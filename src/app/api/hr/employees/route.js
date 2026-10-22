import { listUsersCached, invalidateUsersCache, getTrustedUserById } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission, denyRoleEscalation, denyForeignBranch, scopeListToBranch, denySelfScopeList } from "@/lib/rbac/guard";
import { normalizeEmployeeFields, validateEmployeeRecord } from "@/lib/employees/record";
import { normalizeSuffix } from "@/lib/employees/staff-record";
import {
  emergencyContactColumns,
  normalizeEmergencyContact,
  validateEmergencyContactUpdate,
} from "@/lib/employees/emergency-contact";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { PII_FIELDS, fetchProfilesPii, withoutPiiMetadata } from "@/lib/employees/pii";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { separateEmployee, validateSeparation } from "@/lib/employees/separation";

function toTitleCaseWords(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// The parts are stored on profiles as typed (first_name / middle_name /
// last_name / suffix), so reopening the form shows them exactly as saved
// instead of re-splitting full_name — which can't tell "Jane Marinel | Dela
// Pena" from "Jane | Marinel Dela Pena".
function nameParts(record) {
  return {
    first_name: toTitleCaseWords(record.first_name) || null,
    middle_name: normalizeText(record.middle_initial).replace(/\s+/g, " ") || null,
    last_name: toTitleCaseWords(record.last_name) || null,
    suffix: normalizeSuffix(record.suffix) || null,
  };
}

function composeFullName(parts) {
  return [parts.first_name, parts.middle_name, parts.last_name, parts.suffix].filter(Boolean).join(" ");
}

function shapeEmployee(user, profile) {
  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: normalizeText(profile?.full_name, normalizeText(meta.full_name, user.email)),
    first_name: normalizeText(profile?.first_name),
    middle_name: normalizeText(profile?.middle_name),
    last_name: normalizeText(profile?.last_name),
    suffix: normalizeText(profile?.suffix),
    emergency_contact_name: normalizeText(profile?.emergency_contact_name),
    emergency_contact_relationship: normalizeText(profile?.emergency_contact_relationship),
    emergency_contact_address: normalizeText(profile?.emergency_contact_address),
    emergency_contact_number: normalizeText(profile?.emergency_contact_number),
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
    // Sent back on save: a record changed since it was opened is not
    // overwritten (409 stale_record).
    updated_at: profile?.updated_at || null,
    // profiles is authoritative for these (real, constrained columns —
    // see supabase/migrations/20260914010000_profile_id_fields_and_perf.sql);
    // metadata is only a fallback for a profile row not yet backfilled.
    address: normalizeText(profile?.address, normalizeText(meta.address, "")),
    // Government IDs are filled in by GET from the encrypted columns
    // (src/lib/employees/pii.js).
    cp_number: normalizeText(profile?.cp_number, normalizeText(meta.cp_number, "")),
    date_hired: normalizeText(profile?.date_hired, normalizeText(meta.date_hired, "")),
    branch_id: profile?.branch_id || meta.branch_id || null,
  };
}

const MANAGED_ROLES = ["employee", "accountant"];

export async function GET(request) {
  const guard = await requirePermission(request, "employee_information", "read");
  if (guard.denied) return guard.denied;
  // Employees (own records only) never list colleagues here.
  const selfDenied = denySelfScopeList(guard);
  if (selfDenied) return selfDenied;

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
      // In chunks (the whole id list made the URL too long), and a failure is
      // an error, not a list of employees without their profiles.
      const { data: profiles, error: profileError } = await fetchAllIn(() => supabase
        .from("profiles")
        .select("id,email,full_name,first_name,middle_name,last_name,suffix,emergency_contact_name,emergency_contact_relationship,emergency_contact_address,emergency_contact_number,cp_number,date_hired,branch_id,address,updated_at")
        .order("id", { ascending: true }), "id", userIds);
      if (profileError) throw new Error(profileError.message);
      (profiles || []).forEach((p) => profileMap.set(p.id, p));
    }

    let employees = employeeUsers.map((u) => shapeEmployee(u, profileMap.get(u.id)));

    if (!includeArchived) {
      employees = employees.filter((e) => !e.archived);
    }

    // HR reaches every branch here (SCOPE_ALL); anyone branch-scoped is filtered.
    employees = scopeListToBranch(employees, guard, (e) => e.branch_id);
    employees.sort((a, b) => a.full_name.localeCompare(b.full_name));

    // HR's Edit Employee form needs the full numbers. Decrypted only for the
    // rows this caller may see, after the branch filter above.
    const pii = await fetchProfilesPii(supabase, employees.map((e) => e.id));
    employees = employees.map((e) => {
      const values = pii.get(e.id) || {};
      const filled = { ...e };
      for (const field of PII_FIELDS) filled[field] = values[field] || "";
      return filled;
    });

    return NextResponse.json({ employees, total: employees.length });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// HR can update an employee's identity, personal, employment, contact,
// and government details — but never role, basic salary or branch.
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

    const { data: userData, error: fetchErr } = await getTrustedUserById(supabase, id);
    if (fetchErr || !userData?.user) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const currentMeta = userData.user.user_metadata || {};
    const currentRole = normalizeText(currentMeta.role, "employee").toLowerCase();

    const escalation = denyRoleEscalation(guard, currentRole);
    if (escalation) return escalation;

    // { action: "separate", effective, reason, note }: resigned, end of
    // contract, retired, terminated, deceased (src/lib/employees/separation.js).
    if (normalizeText(body.action).toLowerCase() === "separate") {
      const profile = await supabase.from("profiles").select("id,full_name,employee_id,branch_id,date_hired,employee_status").eq("id", id).maybeSingle();
      if (profile.error || !profile.data) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
      const person = profile.data;
      if (!guard.branchExempt) {
        const foreign = denyForeignBranch(guard, person.branch_id);
        if (foreign) return foreign;
      }
      if (person.employee_status === "Separated") return NextResponse.json({ error: `${person.full_name} is already separated.` }, { status: 409 });
      const separation = { effective: normalizeText(body.effective), reason: normalizeText(body.reason), note: normalizeText(body.note).slice(0, 1000) };
      const invalidSeparation = validateSeparation(separation, { dateHired: person.date_hired });
      if (invalidSeparation) return NextResponse.json({ error: invalidSeparation }, { status: 400 });
      const failed = await separateEmployee(supabase, { employee: person, ...separation, guard });
      if (failed) return NextResponse.json({ error: sanitizeError(failed) }, { status: 500 });
      await appendAuditLog({
        actor: guard, module: "user_management", action: "employee_separated", entity_type: "employee", entity_id: person.employee_id || id,
        description: `${person.full_name} separated (${separation.reason}), last day ${separation.effective}. Pay settles through Final Pay.`,
        status: "success", source: "api", branch_id: person.branch_id || null,
        metadata: { employee_id: id, reason: separation.reason, effective: separation.effective, note: separation.note || null },
      });
      return NextResponse.json({ success: true, separated: { id, effective: separation.effective, reason: separation.reason } });
    }

    const profileResult = await supabase
      .from("profiles")
      .select("branch_id,emergency_contact_name,employee_status,updated_at")
      .eq("id", id)
      .maybeSingle();
    // Two people editing the same employee: the second save would silently
    // overwrite the first. The form sends the version it opened.
    const expected = normalizeText(body.expected_updated_at);
    const current = profileResult.data?.updated_at || null;
    if (expected && current && new Date(expected).getTime() !== new Date(current).getTime()) {
      return NextResponse.json({
        error: "Someone else changed this employee after you opened it. Close and reopen the record to see the latest, then make your change again.",
        code: "stale_record",
      }, { status: 409 });
    }
    const targetBranch = profileResult.data?.branch_id || currentMeta.branch_id || null;
    if (!guard.branchExempt) {
      if (!targetBranch) {
        return NextResponse.json({ error: "That employee is not assigned to your branch." }, { status: 403 });
      }
      const foreign = denyForeignBranch(guard, targetBranch);
      if (foreign) return foreign;
    }

    const record = normalizeEmployeeFields(body);
    // AWOL / Separated are set only by the AWOL case flow (/api/hr/awol-cases,
    // which also holds and releases pay): editing other details keeps them.
    const caseStatus = ["AWOL", "Separated"].includes(profileResult.data?.employee_status) ? profileResult.data.employee_status : null;
    if (caseStatus) record.employee_status = caseStatus;
    const invalid = validateEmployeeRecord(record, { creating: false });
    if (invalid) {
      return NextResponse.json({ error: invalid }, { status: 400 });
    }

    // Older records may have no emergency contact yet; one on file may be
    // changed but not removed (src/lib/employees/emergency-contact.js).
    const emergencyContact = normalizeEmergencyContact(body);
    const emergencyInvalid = validateEmergencyContactUpdate(
      emergencyContact,
      record.cp_number,
      Boolean(profileResult.data?.emergency_contact_name),
    );
    if (emergencyInvalid) {
      return NextResponse.json({ error: emergencyInvalid }, { status: 400 });
    }

    const parts = nameParts(record);
    const fullName = composeFullName(parts);

    // Government IDs go to profiles only, where they are encrypted; any old copy in metadata is dropped.
    const updatedMeta = {
      ...withoutPiiMetadata(currentMeta),
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
        ...parts,
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
        tin_number: record.tin_number,
        ...emergencyContactColumns(emergencyContact),
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
      actor: guard,
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
