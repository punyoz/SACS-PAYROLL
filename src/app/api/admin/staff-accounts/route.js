/**
 * POST /api/admin/staff-accounts — create a Super Admin, Admin or HR account.
 *
 * This is the only way to create these accounts. The old "+ Quick Add"
 * shortcut (a bare name/email/role/password form that POSTed to
 * /api/admin/users) has been removed; /api/admin/users now only lists and
 * edits accounts. This flow follows the shape of HR's employee-creation flow
 * -- a full identity/contact record, and an ISSUED default password the holder
 * must replace on first sign-in, rather than one the Super Admin invents and
 * has to communicate.
 *
 * BRANCH
 * Only Admin is stored with a branch. Super Admin and HR serve every branch
 * and are stored with none (shown as "—" and "All Branches").
 *
 * WHAT IT DELIBERATELY DOES NOT COLLECT
 * basic_salary, SSS, PhilHealth, Pag-IBIG, TIN, bank name, bank account
 * number, and position. See src/lib/employees/staff-record.js — these are operator logins,
 * not payroll records.
 *
 * ACCESS
 * Two independent gates, both server-side:
 *   1. src/proxy.js maps this path to the user_management module, so a role
 *      without it is refused before the handler runs.
 *   2. requirePermission here, then an explicit super_admin check — minting an
 *      admin or another super_admin is the privilege-escalation path, so it is
 *      not enough to hold user_management. denyRoleEscalation() re-checks the
 *      specific target role against MANAGEABLE_ROLES on top of that.
 * An Admin or HR reaching this route is refused at (2) even though HR holds
 * user_management for its own employee/accountant accounts.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { invalidateUsersCache } from "@/lib/auth/users-cache";
import { requirePermission, denyRoleEscalation } from "@/lib/rbac/guard";
import { buildDefaultPassword, hashTemporaryPassword } from "@/lib/auth/password-policy";
import {
  normalizeStaffFields,
  validateStaffRecord,
  STAFF_BRANCH_REQUIRED_ROLES,
} from "@/lib/employees/staff-record";

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

export async function POST(request) {
  const guard = await requirePermission(request, "user_management", "create");
  if (guard.denied) return guard.denied;

  // Gate 2. HR holds user_management (for employee and accountant accounts),
  // so the module check alone would let it through to the role check below.
  // Refusing here keeps this flow Super Admin only, as specified, and makes
  // the failure say so rather than reporting a role-escalation error.
  if (guard.role !== "super_admin") {
    return NextResponse.json(
      { error: "Only a Super Admin can create staff accounts." },
      { status: 403 },
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const record = normalizeStaffFields(body);

    const invalid = validateStaffRecord(record);
    if (invalid) {
      return NextResponse.json({ error: invalid }, { status: 400 });
    }

    // Belt and braces over the super_admin check above: this consults
    // MANAGEABLE_ROLES, the single table that decides who may mint whom.
    const escalation = denyRoleEscalation(guard, record.role);
    if (escalation) return escalation;

    // Super Admin and HR reach every branch, so they are stored without one.
    const branchId = STAFF_BRANCH_REQUIRED_ROLES.includes(record.role)
      ? record.branch_id
      : null;

    const supabase = getAdminClient();

    if (branchId) {
      const { data: branch, error: branchError } = await supabase
        .from("branches")
        .select("id, status")
        .eq("id", branchId)
        .maybeSingle();
      if (branchError || !branch) {
        return NextResponse.json({ error: "The selected branch does not exist." }, { status: 400 });
      }
      if (String(branch.status || "Active").toLowerCase() !== "active") {
        return NextResponse.json({ error: "The selected branch is inactive." }, { status: 400 });
      }
    }

    // Same issued password the employee flow uses: LastName + MMDDYYYY + "!".
    // Never chosen by the creator, and never sent anywhere except back to the
    // Super Admin who created the account so they can hand it over.
    const password = buildDefaultPassword(record.last_name, record.date_of_birth);
    if (!password) {
      return NextResponse.json(
        { error: "Default password could not be generated. Check the last name and date of birth." },
        { status: 400 },
      );
    }

    const metadata = {
      role: record.role,
      full_name: record.full_name,
      branch_id: branchId,
      date_of_birth: record.date_of_birth,
      sex: record.sex,
      civil_status: record.civil_status,
      date_hired: record.date_hired,
      employee_status: record.employee_status,
      address: record.address,
      cp_number: record.cp_number,
      archived: false,
    };

    const createResult = await supabase.auth.admin.createUser({
      email: record.email,
      password,
      email_confirm: true,
      user_metadata: metadata,
      // Marks the password as one-time. mustChangePassword() reads this at
      // sign-in and forces the change-password screen before the account can
      // reach anything else — including for the roles that now skip OTP.
      app_metadata: { temp_password_hash: hashTemporaryPassword(password) },
    });

    if (createResult.error) {
      return NextResponse.json({ error: sanitizeError(createResult.error) }, { status: 400 });
    }

    invalidateUsersCache();

    const newUser = createResult.data.user;
    const profileResult = await supabase.from("profiles").upsert(
      {
        id: newUser.id,
        email: record.email,
        role: record.role,
        // Stored split; full_name is the composed "First Middle Last Suffix"
        // (the profiles trigger recomputes it from these parts as well).
        first_name: record.first_name,
        middle_name: record.middle_name || null,
        last_name: record.last_name,
        suffix: record.suffix || null,
        full_name: record.full_name,
        branch_id: branchId,
      },
      { onConflict: "id" },
    );

    // The auth account exists either way at this point, so a failed profile
    // write is reported rather than silently swallowed — the same handling
    // /api/admin/users uses.
    if (profileResult.error) {
      return NextResponse.json(
        {
          error: `Account created, but its profile row failed: ${sanitizeError(profileResult.error)}`,
        },
        { status: 500 },
      );
    }

    await appendAuditLog({
      module: "user_management",
      action: "create",
      entity_type: "account",
      entity_id: newUser.id,
      description: `Staff account created for ${record.full_name} (${record.role}).`,
      status: "success",
      source: "api",
      actor_id: guard.userId,
      // The password itself is never logged — only that one was issued.
      metadata: { role: record.role, branch_id: branchId, email: record.email },
    });

    return NextResponse.json({
      success: true,
      id: newUser.id,
      role: record.role,
      // Shown once to the Super Admin so they can pass it on. The holder is
      // forced to replace it on first sign-in.
      temporary_password: password,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
