/**
 * Resolves an authenticated auth.users row into the profile fields the login
 * flow needs — role, branch, and the extended profile bundle every portal's
 * "Profile" self-view reads.
 *
 * Moved verbatim out of src/app/api/legacy-auth/login/route.js (no behaviour
 * change) when login became two-factor: the password-check step
 * (src/app/api/legacy-auth/login/route.js) and the OTP-verify step
 * (src/app/api/legacy-auth/verify-login-otp/route.js) both need this same
 * resolution — the former just to compute must_change_password from
 * resolvedFullName, the latter to build the full session + response. Two
 * independent copies of this logic would be exactly the kind of drift this
 * codebase has already been bitten by (see the HR payroll/payslips
 * permission-matrix drift fixed earlier); one shared function cannot drift
 * from itself.
 */

import { createClient } from "@supabase/supabase-js";
import { normalizeRole, normalizeText } from "@/lib/auth/normalize";

function toTitleCaseWords(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferNameFromEmail(email) {
  const raw = normalizeText(email);
  const localPart = raw.includes("@") ? raw.split("@")[0] : raw;
  if (!localPart) return "";

  const cleaned = localPart.replace(/[._-]+/g, " ");
  return toTitleCaseWords(cleaned);
}

function normalizePositionForRole(positionInput, roleInput) {
  const role = normalizeRole(roleInput);
  const position = normalizeText(positionInput).toLowerCase();

  if (role === "accountant" || position === "accountant" || position.includes("account")) {
    return "Accountant";
  }

  return "Employee";
}

/**
 * @param {{ url: string, serviceRoleKey: string|undefined, user: object, actualRole: string }} args
 *   `user` is a Supabase auth user object (data.user from signInWithPassword,
 *   or the equivalent looked up by id). `actualRole` is the raw, unnormalized
 *   role string already validated against the known routable roles.
 */
export async function resolveLoginProfile({ url, serviceRoleKey, user, actualRole }) {
  const metadata = user.user_metadata || {};

  let profileRow = null;
  if (serviceRoleKey) {
    const adminClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const profileResult = await adminClient
      .from("profiles")
      .select("id,email,full_name,first_name,middle_name,last_name,suffix,emergency_contact_name,emergency_contact_relationship,emergency_contact_address,emergency_contact_number,role,employee_id,employee_type,position,branch_id,cp_number,date_hired,address,sss_number,pagibig_number,philhealth_number,bank_name,bank_account_number")
      .eq("id", user.id)
      .maybeSingle();

    if (!profileResult.error) {
      profileRow = profileResult.data || null;
    }

    // STAFF-### for Super Admin / Admin / HR. Read on its own so a database
    // without the staff_id column yet (20260924150000_profiles_staff_id.sql)
    // does not lose the whole profile row above.
    if (profileRow && ["super_admin", "admin", "hr"].includes(normalizeRole(profileRow.role || actualRole))) {
      const staffResult = await adminClient
        .from("profiles")
        .select("staff_id")
        .eq("id", user.id)
        .maybeSingle();
      if (!staffResult.error && staffResult.data?.staff_id) {
        profileRow.staff_id = staffResult.data.staff_id;
      }
    }
  }

  const resolvedEmailOutput = normalizeText(profileRow?.email, normalizeText(user.email));
  const resolvedFullName = normalizeText(
    profileRow?.full_name,
    normalizeText(metadata.full_name, inferNameFromEmail(resolvedEmailOutput)),
  );
  const resolvedRole = normalizeRole(profileRow?.role || actualRole);
  const resolvedEmployeeId = normalizeText(profileRow?.employee_id, normalizeText(metadata.employee_id));
  const resolvedEmployeeType = normalizeText(profileRow?.employee_type, normalizeText(metadata.employee_type));
  const resolvedPosition = normalizeText(
    profileRow?.position,
    normalizeText(metadata.position, normalizePositionForRole(metadata.position, resolvedRole)),
  );

  // The branch this account is boxed inside. profiles.branch_id is the source
  // of truth (see supabase/migrations/20260903010000_rbac_branch_scoping.sql); the
  // auth metadata copy is only a fallback for accounts created before that
  // column existed. Super Admin is deliberately left null — it is branch-exempt.
  const resolvedBranchId = resolvedRole === "super_admin"
    ? null
    : normalizeText(profileRow?.branch_id, normalizeText(metadata.branch_id)) || null;

  return {
    profileRow,
    metadata,
    resolvedEmailOutput,
    resolvedFullName,
    resolvedRole,
    resolvedEmployeeId,
    resolvedEmployeeType,
    resolvedPosition,
    resolvedBranchId,
  };
}

/**
 * Shapes the `profile` object every role's self-view reads, exactly as the
 * pre-2FA login response body did.
 */
export function buildProfilePayload(resolved, passwordChangeRequired) {
  const { profileRow, metadata } = resolved;

  return {
    role: resolved.resolvedRole,
    full_name: resolved.resolvedFullName,
    // Stored name parts (20260924010000_profiles_name_parts.sql), so the
    // Edit Account dialog opens with the split the person saved rather than
    // a guess from full_name. Empty for a profile that has none yet.
    first_name: normalizeText(profileRow?.first_name, ""),
    middle_name: normalizeText(profileRow?.middle_name, ""),
    last_name: normalizeText(profileRow?.last_name, ""),
    suffix: normalizeText(profileRow?.suffix, ""),
    // Shown read-only on every Profile page; set by HR / Super Admin.
    emergency_contact_name: normalizeText(profileRow?.emergency_contact_name, ""),
    emergency_contact_relationship: normalizeText(profileRow?.emergency_contact_relationship, ""),
    emergency_contact_address: normalizeText(profileRow?.emergency_contact_address, ""),
    emergency_contact_number: normalizeText(profileRow?.emergency_contact_number, ""),
    email: resolved.resolvedEmailOutput,
    employee_id: resolved.resolvedEmployeeId,
    // Super Admin / Admin / HR only; see src/lib/employees/staff-id.js.
    staff_id: normalizeText(profileRow?.staff_id, ""),
    employee_type: resolved.resolvedEmployeeType,
    position: resolved.resolvedPosition,
    branch_id: resolved.resolvedBranchId,
    // profiles is authoritative for these (real, constrained columns — see
    // supabase/migrations/20260914010000_profile_id_fields_and_perf.sql); metadata
    // is only a fallback for a profile row not yet backfilled. This context
    // feeds every role's own "Profile" self-view, so this is the one place
    // all of them read from.
    cp_number: normalizeText(profileRow?.cp_number, normalizeText(metadata.cp_number, "")),
    date_hired: normalizeText(profileRow?.date_hired, normalizeText(metadata.date_hired, "")),
    address: normalizeText(profileRow?.address, normalizeText(metadata.address, "")),
    sss_number: normalizeText(profileRow?.sss_number, normalizeText(metadata.sss_number, "")),
    pagibig_number: normalizeText(profileRow?.pagibig_number, normalizeText(metadata.pagibig_number, "")),
    philhealth_number: normalizeText(profileRow?.philhealth_number, normalizeText(metadata.philhealth_number, "")),
    bank_name: normalizeText(profileRow?.bank_name, normalizeText(metadata.bank_name, "")),
    bank_account_number: normalizeText(profileRow?.bank_account_number, normalizeText(metadata.bank_account_number, "")),
    tin_number: normalizeText(metadata.tin_number, ""),
    sex: normalizeText(metadata.sex, ""),
    civil_status: normalizeText(metadata.civil_status, ""),
    employment_type: normalizeText(metadata.employment_type, ""),
    employment_status: normalizeText(metadata.employment_status, ""),
    date_of_birth: normalizeText(metadata.date_of_birth, ""),
    must_change_password: Boolean(passwordChangeRequired),
  };
}
