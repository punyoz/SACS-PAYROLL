import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { normalizeRole, normalizeRoleEmail, normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import {
  requirePermission,
  denyRoleEscalation,
  denyForeignBranch,
  scopeListToBranch,
} from "@/lib/rbac/guard";
import { hashTemporaryPassword, validateNewPassword } from "@/lib/auth/password-policy";
import { invalidateBranchCache } from "@/lib/auth/live-branch";
import { syncProfileArchive } from "@/lib/employees/archive";
import { assignStaffId, fetchStaffIdMap, isStaffIdRole } from "@/lib/employees/staff-id";
import {
  EMERGENCY_CONTACT_FIELDS,
  emergencyContactColumns,
  normalizeEmergencyContact,
  validateEmergencyContactUpdate,
} from "@/lib/employees/emergency-contact";
import {
  normalizeNameParts,
  splitFullName,
  validateNameParts,
  validateStaffEmail,
} from "@/lib/employees/staff-record";

/**
 * GET lists accounts; PATCH edits, archives or restores one.
 *
 * Accounts are created elsewhere: Super Admin / Admin / HR through
 * POST /api/admin/staff-accounts, Employee / Accountant through
 * POST /api/admin/employees. The POST handler that used to live here served
 * only the Super Admin "+ Quick Add" button, and was removed with it.
 */

// Roles that serve every branch and are stored with no branch.
const BRANCHLESS_ROLES = ["super_admin", "hr"];

const PROFILE_COLUMNS = "id,email,full_name,role,branch_id,cp_number,date_hired,address,sss_number,pagibig_number,philhealth_number,bank_name,bank_account_number";
// Added by 20260924010000_profiles_name_parts.sql.
const NAME_PART_COLUMNS = "first_name,middle_name,last_name,suffix";
// Added by 20260924134806_profiles_emergency_contact.sql.
const EMERGENCY_COLUMNS = "emergency_contact_name,emergency_contact_relationship,emergency_contact_address,emergency_contact_number";

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

function shapeUser(user, profile) {
  const metadata = user.user_metadata || {};
  const role = normalizeRole(metadata.role);
  const fullName = normalizeText(profile?.full_name, normalizeText(metadata.full_name, user.email));
  // Stored parts when the account has them; otherwise split the full name so
  // the Edit dialog still opens pre-filled.
  const parts = profile?.first_name || profile?.last_name
    ? profile
    : splitFullName(fullName);
  return {
    id: user.id,
    email: normalizeText(profile?.email, user.email),
    full_name: fullName,
    first_name: normalizeText(parts.first_name),
    middle_name: normalizeText(parts.middle_name),
    last_name: normalizeText(parts.last_name),
    suffix: normalizeText(parts.suffix),
    emergency_contact_name: normalizeText(profile?.emergency_contact_name),
    emergency_contact_relationship: normalizeText(profile?.emergency_contact_relationship),
    emergency_contact_address: normalizeText(profile?.emergency_contact_address),
    emergency_contact_number: normalizeText(profile?.emergency_contact_number),
    role,
    employee_id: normalizeText(metadata.employee_id, ""),
    // STAFF-### for Super Admin / Admin / HR (src/lib/employees/staff-id.js).
    staff_id: isStaffIdRole(role) ? normalizeText(profile?.staff_id, "") : "",
    // Super Admin and HR serve every branch; a stale branch left on one of
    // them is never shown.
    branch_id: BRANCHLESS_ROLES.includes(role) ? null : (profile?.branch_id || metadata.branch_id || null),
    archived: Boolean(metadata.archived),
    last_sign_in: user.last_sign_in_at || null,
    created_at: user.created_at || null,
    // Live on profiles, not user_metadata (see
    // supabase/migrations/20260910010000_transfer_requests_and_employee_contact.sql
    // and 20260914010000_profile_id_fields_and_perf.sql). Displayed read-only on
    // the merged employee table's "View Details" — not editable from this
    // route's own modal (sa-admin-user-modal covers account fields only).
    cp_number: normalizeText(profile?.cp_number, ""),
    date_hired: normalizeText(profile?.date_hired, ""),
    address: normalizeText(profile?.address, ""),
    sss_number: normalizeText(profile?.sss_number, ""),
    pagibig_number: normalizeText(profile?.pagibig_number, ""),
    philhealth_number: normalizeText(profile?.philhealth_number, ""),
    bank_name: normalizeText(profile?.bank_name, ""),
    bank_account_number: normalizeText(profile?.bank_account_number, ""),
  };
}

/**
 * The branch a user belongs to, read from profiles first (the source of truth
 * since 20260903010000_rbac_branch_scoping.sql) and falling back to auth metadata for
 * accounts created before that column existed.
 */
async function fetchUserBranch(supabase, userId, metadata) {
  const profileResult = await supabase
    .from("profiles")
    .select("branch_id,role")
    .eq("id", userId)
    .maybeSingle();

  if (!profileResult.error && profileResult.data?.branch_id) {
    return profileResult.data.branch_id;
  }
  return metadata?.branch_id || null;
}

async function fetchAllUsers(supabase) {
  const usersResult = await listUsersCached(supabase);
  if (usersResult.error) {
    throw new Error(`Failed to list users: ${usersResult.error.message}`);
  }

  const users = usersResult.data.users || [];
  const userIds = users.map((u) => u.id);
  const profileMap = new Map();

  if (userIds.length) {
    let profileResult = await supabase
      .from("profiles")
      .select(`${PROFILE_COLUMNS},${NAME_PART_COLUMNS},${EMERGENCY_COLUMNS}`)
      .in("id", userIds);

    // Before the name-parts migration runs, those columns do not exist and
    // the whole select fails. Fall back to the old column list rather than
    // dropping every profile (and with it every branch) from the listing.
    if (profileResult.error) {
      profileResult = await supabase.from("profiles").select(PROFILE_COLUMNS).in("id", userIds);
    }

    if (!profileResult.error) {
      (profileResult.data || []).forEach((p) => profileMap.set(p.id, p));
    }

    // Read on its own so a database without the staff_id column yet still
    // lists every account (just without an ID).
    const staffIds = await fetchStaffIdMap(supabase, userIds);
    staffIds.forEach((staffId, id) => {
      const existing = profileMap.get(id);
      if (existing) existing.staff_id = staffId;
    });
  }

  return users
    .map((user) => shapeUser(user, profileMap.get(user.id)))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function GET(request) {
  const guard = await requirePermission(request, "user_management", "read");
  if (guard.denied) return guard.denied;

  try {
    const supabase = getAdminClient();
    const users = await fetchAllUsers(supabase);

    // Branch-scoped roles see only their own branch's accounts, and never the
    // admin / super_admin accounts they are not allowed to manage.
    const visible = guard.branchExempt
      ? users
      : scopeListToBranch(users, guard, (u) => u.branch_id)
          .filter((u) => !["admin", "super_admin"].includes(u.role));

    return NextResponse.json({ users: visible });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const requestedAction = normalizeText(body.action, "update").toLowerCase();

  // Archiving is the matrix's "delete"; everything else on this route is an
  // update. Ask for the permission that actually matches the intent.
  const guard = await requirePermission(
    request,
    "user_management",
    requestedAction === "archive" ? "delete" : "update",
  );
  if (guard.denied) return guard.denied;

  try {
    const id = normalizeText(body.id);
    const action = requestedAction;

    if (!id) {
      return NextResponse.json({ error: "User id is required." }, { status: 400 });
    }

    const supabase = getAdminClient();
    const userResult = await supabase.auth.admin.getUserById(id);
    if (userResult.error || !userResult.data?.user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const existingUser = userResult.data.user;
    const currentMetadata = existingUser.user_metadata || {};

    // Two separate checks, because privilege escalation can come from either
    // direction: editing an account that already outranks the caller, or
    // promoting a low-privilege account into one that does.
    const currentRole = normalizeRole(currentMetadata.role);
    const escalationOnTarget = denyRoleEscalation(guard, currentRole);
    if (escalationOnTarget) return escalationOnTarget;

    if (action === "update" && body.role) {
      const escalationOnNewRole = denyRoleEscalation(guard, normalizeRole(body.role));
      if (escalationOnNewRole) return escalationOnNewRole;
    }

    // Archiving a Super Admin is the one action that can lock everybody out
    // of the system permanently: Super Admin is the only role that can mint
    // another one, so losing the last active one is unrecoverable from inside
    // the app. Two refusals cover both ways it happens -- archiving yourself,
    // and archiving the last one left. Both are checked here rather than in
    // the browser because the browser is not a place a rule can be enforced.
    //
    // Necessary now that Super Admin accounts are listed and editable in the
    // Super Admin portal; before that they were unreachable from this screen.
    if (action === "archive" && !currentMetadata.archived) {
      if (String(id) === String(guard.userId)) {
        return NextResponse.json(
          { error: "You cannot archive your own account." },
          { status: 400 },
        );
      }

      if (currentRole === "super_admin") {
        const everyone = await listUsersCached(supabase);
        if (everyone.error) {
          // Refuse rather than guess. Letting the archive through because the
          // count could not be read is exactly the case this guard exists for.
          return NextResponse.json(
            { error: "Unable to verify how many Super Admins remain. Try again." },
            { status: 503 },
          );
        }
        const activeSuperAdmins = (everyone.data.users || []).filter((candidate) => {
          const metadata = candidate.user_metadata || {};
          return normalizeRole(metadata.role) === "super_admin"
            && metadata.archived !== true;
        });

        if (activeSuperAdmins.length <= 1) {
          return NextResponse.json(
            {
              error: "This is the last active Super Admin. Create another one before archiving this account.",
            },
            { status: 400 },
          );
        }
      }
    }

    // ...and the target must live in the caller's own branch. An account with
    // no branch on file is refused rather than allowed through: a branch-scoped
    // caller has no claim on a record it cannot place.
    const targetBranch = await fetchUserBranch(supabase, id, currentMetadata);
    if (!guard.branchExempt && !targetBranch) {
      return NextResponse.json(
        { error: "That account is not assigned to your branch." },
        { status: 403 },
      );
    }
    const foreign = denyForeignBranch(guard, targetBranch);
    if (foreign) return foreign;

    const nextMetadata = { ...currentMetadata };

    // Emergency contact, when the Edit dialog sent it (older callers do not).
    // An account with none on file may leave it blank; one on file may be
    // changed but not removed.
    let emergencyContact = null;
    if (action === "update" && EMERGENCY_CONTACT_FIELDS.some((key) => body[key] !== undefined)) {
      emergencyContact = normalizeEmergencyContact(body);
      const { data: existing } = await supabase
        .from("profiles")
        .select("emergency_contact_name")
        .eq("id", id)
        .maybeSingle();
      const emergencyInvalid = validateEmergencyContactUpdate(
        emergencyContact,
        normalizeText(currentMetadata.cp_number),
        Boolean(existing?.emergency_contact_name),
      );
      if (emergencyInvalid) return NextResponse.json({ error: emergencyInvalid }, { status: 400 });
    }
    // Set when the caller sent First / Middle / Last / Suffix (the Super Admin
    // Edit dialog); older callers send full_name only.
    let nameParts = null;

    if (action === "archive") {
      nextMetadata.archived = true;
    } else if (action === "restore") {
      nextMetadata.archived = false;
    } else {
      nextMetadata.role = normalizeRole(body.role || currentMetadata.role);
      const sentParts = ["first_name", "middle_name", "last_name", "suffix"]
        .some((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (sentParts) {
        nameParts = normalizeNameParts(body);
        const nameError = validateNameParts(nameParts, body.suffix);
        if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
        nextMetadata.full_name = nameParts.full_name;
      } else {
        nextMetadata.full_name = normalizeText(
          body.full_name,
          normalizeText(currentMetadata.full_name, existingUser.email),
        );
      }
      // Super Admin and HR serve every branch and carry none.
      if (BRANCHLESS_ROLES.includes(nextMetadata.role)) {
        nextMetadata.branch_id = null;
      }
    }

    const updatePayload = { user_metadata: nextMetadata };

    if (action === "update") {
      if (normalizeText(body.email)) {
        const emailError = validateStaffEmail(normalizeText(body.email).toLowerCase());
        if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });
      }
      const email = normalizeRoleEmail(normalizeText(body.email, existingUser.email));
      if (email) updatePayload.email = email;
      const password = normalizeText(body.password);
      if (password) {
        // Same rules as every other password a person sets (Task 2):
        // 8-72 characters, letters and numbers, an uppercase letter, a symbol.
        const passwordError = validateNewPassword(password);
        if (passwordError) {
          return NextResponse.json({ error: passwordError.replace(/^New password/, "Password") }, { status: 400 });
        }
        updatePayload.password = password;
        // A password reset by Super Admin is a one-time password too.
        updatePayload.app_metadata = { temp_password_hash: hashTemporaryPassword(password) };
      }
    }

    const updatedResult = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (updatedResult.error) {
      return NextResponse.json({ error: sanitizeError(updatedResult.error) }, { status: 400 });
    }

    invalidateUsersCache();

    if (action === "archive" || action === "restore") {
      const archiveError = await syncProfileArchive(supabase, id, action === "archive", guard.userId);
      if (archiveError) {
        return NextResponse.json(
          { error: `Account ${action}d, but its profile record failed: ${sanitizeError(archiveError)}` },
          { status: 500 },
        );
      }
    }

    if (action === "update") {
      const email = updatePayload.email || existingUser.email;
      const profileRow = { id, email, role: nextMetadata.role, full_name: nextMetadata.full_name };
      if (emergencyContact) Object.assign(profileRow, emergencyContactColumns(emergencyContact));
      if (nameParts) {
        profileRow.first_name = nameParts.first_name;
        profileRow.middle_name = nameParts.middle_name || null;
        profileRow.last_name = nameParts.last_name;
        profileRow.suffix = nameParts.suffix || null;
      }
      const clearBranch = BRANCHLESS_ROLES.includes(nextMetadata.role);
      if (clearBranch) profileRow.branch_id = null;

      const profileResult = await supabase.from("profiles").upsert(profileRow, { onConflict: "id" });
      if (profileResult.error) {
        return NextResponse.json(
          { error: `Account updated, but its profile record failed: ${sanitizeError(profileResult.error)}` },
          { status: 500 },
        );
      }

      // An account moved into a staff role gets its STAFF-### now; one that
      // already has an ID keeps it.
      if (isStaffIdRole(nextMetadata.role)) {
        await assignStaffId(supabase, id);
      }

      if (clearBranch) {
        // The assignment row would otherwise keep a branch alive for this
        // account (its trigger writes profiles.branch_id back).
        await supabase.from("employee_branch_assignments").delete().eq("user_id", id);
        invalidateBranchCache(id);
      }
    }

    const updatedUser = updatedResult.data.user;
    await appendAuditLog({
      module: "users",
      action,
      entity_type: "user",
      entity_id: id,
      description: `User ${nextMetadata.full_name || existingUser.email} was ${action}d by admin.`,
      status: "success",
      source: "api",
      metadata: { user_id: id, role: nextMetadata.role, action },
    });

    return NextResponse.json({
      user: shapeUser(updatedUser, {
        email: updatePayload.email || existingUser.email,
        full_name: nextMetadata.full_name,
        role: nextMetadata.role,
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
