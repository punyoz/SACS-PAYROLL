import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText, normalizeDigits } from "@/lib/auth/normalize";
import { requirePermission, resolveTargetEmail } from "@/lib/rbac/guard";
import { sanitizeError } from "@/lib/api-error";
import { normalizeNameParts, validateNameParts } from "@/lib/employees/staff-record";
import {
  EMERGENCY_CONTACT_FIELDS,
  emergencyContactColumns,
  normalizeEmergencyContact,
  validateEmergencyContactUpdate,
} from "@/lib/employees/emergency-contact";
import { PII_FIELDS, PII_LAST4_COLUMNS, maskLast4, maskedPii, withoutPiiMetadata } from "@/lib/employees/pii";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Employee and Accountant bank details and government numbers are set by HR
// (payroll pays into the account and files contributions under the numbers),
// so neither can change their own here; other roles' settings still can.
const BANK_LOCKED_ROLES = ["employee", "accountant"];

// Admin and Super Admin are operator logins, not payees: no bank details at
// all (the profiles_protect_pii trigger strips them in the database too).
const NO_BANK_ROLES = ["admin", "super_admin"];

const CONTACT_NUMBER_PATTERN = /^09\d{9}$/;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 200;

// Same formats as HR's Add/Edit Employee (src/lib/employees/record.js).
const GOVERNMENT_ID_RULES = [
  ["sss_number", [10], "SSS number must be exactly 10 digits."],
  ["philhealth_number", [12], "PhilHealth number must be exactly 12 digits."],
  ["pagibig_number", [12], "Pag-IBIG number must be exactly 12 digits."],
  ["tin_number", [9, 12], "TIN must be 9 digits, or 12 digits including the branch code."],
];

const PROFILE_SELECT = [
  "full_name", "first_name", "middle_name", "last_name", "suffix",
  "cp_number", "address", "bank_name", PII_LAST4_COLUMNS, ...EMERGENCY_CONTACT_FIELDS,
].join(",");

/**
 * GET: the caller's own stored name parts, contact details, emergency
 * contact, government numbers and bank details (the Profile page and its
 * Edit Account dialog) and, for staff accounts, the STAFF-### ID. Government
 * numbers and the bank account are masked ("••••1234"): they are encrypted
 * at rest and never sent back in full (src/lib/employees/pii.js).
 */
export async function GET(request) {
  const guard = await requirePermission(request, "profile", "read");
  if (guard.denied) return guard.denied;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Server configuration error." }, { status: 500 });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("id", guard.userId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  const profile = { ...(data || {}), ...maskedPii(data) };
  for (const field of PII_FIELDS) delete profile[`${field}_last4`];
  // Staff ID read separately: before 20260924150000_profiles_staff_id.sql
  // the column does not exist, and the profile above must still load.
  const { data: staffRow, error: staffError } = await supabase
    .from("profiles")
    .select("staff_id")
    .eq("id", guard.userId)
    .maybeSingle();
  if (!staffError && staffRow?.staff_id) profile.staff_id = staffRow.staff_id;
  return NextResponse.json(
    { profile },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request) {
  // "profile" is SCOPE_SELF for every role in the matrix, so this always
  // resolves to the caller's own session email. Previously the account to edit
  // was taken from body.email with no check that it was the caller's, which
  // let any signed-in user rewrite another employee's bank_account_number —
  // i.e. redirect someone else's salary payment.
  const guard = await requirePermission(request, "profile", "update");
  if (guard.denied) return guard.denied;

  const body = await request.json().catch(() => ({}));

  const email = resolveTargetEmail(guard, body.email);

  // A caller that sends First / Middle / Last / Suffix has them stored as
  // typed; an older caller sending only full_name keeps the old behaviour
  // (the profiles trigger splits it).
  const sentParts = ["first_name", "middle_name", "last_name", "suffix"]
    .some((key) => body[key] !== undefined);
  let nameParts = null;
  if (sentParts) {
    nameParts = normalizeNameParts(body);
    const nameError = validateNameParts(nameParts, body.suffix);
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 });
    }
  }
  const full_name = nameParts ? nameParts.full_name : normalizeText(body.full_name, "");

  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }

  if (!full_name) {
    return NextResponse.json({ error: "Full name is required." }, { status: 400 });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Server configuration error." }, { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: usersData, error: listError } = await listUsersCached(supabase);
  if (listError) {
    return NextResponse.json({ error: "Failed to verify account." }, { status: 500 });
  }

  const user = (usersData.users || []).find(
    (u) => (u.email || "").toLowerCase() === email.toLowerCase(),
  );

  if (!user) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const currentMeta = user.user_metadata || {};
  const bankLocked = BANK_LOCKED_ROLES.includes(guard.role);

  const { data: currentProfile, error: currentError } = await supabase
    .from("profiles")
    .select("cp_number,address,emergency_contact_name")
    .eq("id", user.id)
    .maybeSingle();
  if (currentError) {
    return NextResponse.json({ error: sanitizeError(currentError) }, { status: 500 });
  }

  // An absent field is left as it is rather than wiped. A contact number or
  // address already on file may be changed but not removed -- HR relies on
  // both to reach the person.
  let cp_number;
  if (body.cp_number !== undefined) {
    cp_number = normalizeDigits(body.cp_number, 11);
    if (!cp_number && currentProfile?.cp_number) {
      return NextResponse.json({ error: "Contact number cannot be removed. Enter the new number instead." }, { status: 400 });
    }
    if (cp_number && !CONTACT_NUMBER_PATTERN.test(cp_number)) {
      return NextResponse.json({ error: "Contact number must be an 11-digit PH mobile number starting with 09." }, { status: 400 });
    }
  }

  let address;
  if (body.address !== undefined) {
    address = normalizeText(body.address, "").replace(/\s+/g, " ");
    if (!address && currentProfile?.address) {
      return NextResponse.json({ error: "Home address cannot be removed. Enter the new address instead." }, { status: 400 });
    }
    if (address && address.length < ADDRESS_MIN) {
      return NextResponse.json({ error: "Enter the complete home address." }, { status: 400 });
    }
    if (address.length > ADDRESS_MAX) {
      return NextResponse.json({ error: `Home address must be at most ${ADDRESS_MAX} characters.` }, { status: 400 });
    }
  }

  // Emergency contact: the same rule as HR's Edit Employee -- all four
  // fields or none, and one on file may be changed but not removed.
  const sentEmergency = EMERGENCY_CONTACT_FIELDS.some((key) => body[key] !== undefined);
  let emergencyContact = null;
  if (sentEmergency) {
    emergencyContact = normalizeEmergencyContact(body);
    const ownNumber = cp_number !== undefined ? cp_number : currentProfile?.cp_number || "";
    const emergencyError = validateEmergencyContactUpdate(
      emergencyContact,
      ownNumber,
      Boolean(currentProfile?.emergency_contact_name),
    );
    if (emergencyError) {
      return NextResponse.json({ error: emergencyError }, { status: 400 });
    }
  }

  // Employee and Accountant bank details and government numbers stay HR's
  // call, through the employee-management routes. Showing the fields
  // read-only on their form is not enough (a direct API call would bypass
  // it), so whatever the body sends is ignored for those roles.
  const payrollPatch = {};
  if (!bankLocked) {
    for (const [key, lengths, message] of GOVERNMENT_ID_RULES) {
      if (body[key] === undefined) continue;
      const digits = normalizeDigits(body[key]);
      if (digits && !lengths.includes(digits.length)) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      payrollPatch[key] = digits;
    }
    if (NO_BANK_ROLES.includes(guard.role)) {
      // Nothing to store; also clear any copy left in metadata.
      payrollPatch.bank_name = "";
      payrollPatch.bank_account_number = "";
    } else {
      if (body.bank_name !== undefined) {
        const bankName = normalizeText(body.bank_name, "");
        if (bankName.length > 50) {
          return NextResponse.json({ error: "Bank name must be at most 50 characters." }, { status: 400 });
        }
        payrollPatch.bank_name = bankName;
      }
      if (body.bank_account_number !== undefined) {
        const account = normalizeDigits(body.bank_account_number);
        if (account && (account.length < 6 || account.length > 20)) {
          return NextResponse.json({ error: "Bank account number must be 6 to 20 digits." }, { status: 400 });
        }
        payrollPatch.bank_account_number = account;
      }
    }
  }

  // Government IDs and the bank account number go to profiles only, where
  // they are encrypted -- user_metadata travels in the access token. Any old
  // copy there is dropped.
  const updatedMeta = { ...withoutPiiMetadata(currentMeta), full_name };
  if (payrollPatch.bank_name !== undefined) updatedMeta.bank_name = payrollPatch.bank_name;
  if (address !== undefined) updatedMeta.address = address;
  if (cp_number !== undefined) updatedMeta.cp_number = cp_number;

  const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: updatedMeta,
  });

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  invalidateUsersCache();

  // profiles is authoritative for cp_number, address, the government numbers
  // and bank details (see
  // supabase/migrations/20260910010000_transfer_requests_and_employee_contact.sql
  // and 20260914010000_profile_id_fields_and_perf.sql) — every employee-listing
  // route and the sign-in context read them from there, not user_metadata.
  const profilePatch = { full_name };
  if (nameParts) {
    profilePatch.first_name = nameParts.first_name;
    profilePatch.middle_name = nameParts.middle_name || null;
    profilePatch.last_name = nameParts.last_name;
    profilePatch.suffix = nameParts.suffix || null;
  }
  if (cp_number !== undefined) profilePatch.cp_number = cp_number || null;
  if (address !== undefined) profilePatch.address = address || null;
  if (emergencyContact) Object.assign(profilePatch, emergencyContactColumns(emergencyContact));
  if (payrollPatch.bank_name !== undefined) profilePatch.bank_name = payrollPatch.bank_name || null;
  // Written as typed; the profiles_protect_pii trigger encrypts them. '' (not
  // NULL) is what clears one -- NULL would keep the stored value.
  for (const key of PII_FIELDS) {
    if (payrollPatch[key] !== undefined) profilePatch[key] = payrollPatch[key];
  }
  // This write was previously fire-and-forget. When it failed, user_metadata
  // had already been updated but profiles had not — and the response still
  // said success, so the edit appeared to save and then reappeared stale on
  // the next load, because every employee-listing route reads these columns
  // from profiles rather than from metadata.
  const { error: profileError } = await supabase
    .from("profiles")
    .update(profilePatch)
    .eq("id", user.id);

  if (profileError) {
    return NextResponse.json(
      {
        error: sanitizeError(
          profileError,
          "Your profile was only partly saved. Please try again.",
        ),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    profile: {
      full_name: updatedMeta.full_name,
      first_name: nameParts?.first_name,
      middle_name: nameParts?.middle_name,
      last_name: nameParts?.last_name,
      suffix: nameParts?.suffix,
      address: updatedMeta.address,
      cp_number: updatedMeta.cp_number,
      ...(emergencyContact ? emergencyContactColumns(emergencyContact) : {}),
      // Only what this call stored, masked; a locked role's values are
      // unchanged and the caller keeps what it already shows.
      ...Object.fromEntries(Object.entries(payrollPatch).map(([key, value]) => [
        key,
        PII_FIELDS.includes(key) ? maskLast4(value.slice(-4)) : value,
      ])),
    },
  });
}
