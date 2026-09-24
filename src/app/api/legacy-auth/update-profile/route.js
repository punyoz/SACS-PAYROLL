import { listUsersCached, invalidateUsersCache } from "@/lib/auth/users-cache";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeText, normalizeDigits } from "@/lib/auth/normalize";
import { requirePermission, resolveTargetEmail } from "@/lib/rbac/guard";
import { sanitizeError } from "@/lib/api-error";
import { normalizeNameParts, validateNameParts } from "@/lib/employees/staff-record";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Employee and Accountant bank details are set by HR (payroll pays into
// them), so neither can change their own here; other roles' settings still can.
const BANK_LOCKED_ROLES = ["employee", "accountant"];

/**
 * GET: the caller's own stored name parts (for the Edit Account dialog when
 * the sign-in context predates them), emergency contact (the Profile
 * page's read-only card) and, for staff accounts, the STAFF-### ID.
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
    .select("full_name,first_name,middle_name,last_name,suffix,emergency_contact_name,emergency_contact_relationship,emergency_contact_address,emergency_contact_number")
    .eq("id", guard.userId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  // Staff ID read separately: before 20260924150000_profiles_staff_id.sql
  // the column does not exist, and the profile above must still load.
  const profile = data || {};
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

  const updatedMeta = { ...currentMeta, full_name };
  // Employee and Accountant bank details stay HR's call, through the
  // employee-management routes. Leaving the fields off their form is not
  // enough (a direct API call would bypass it), so whatever the body sends
  // is ignored for those roles. For the rest, an absent field is left as it
  // is rather than wiped.
  if (!bankLocked) {
    if (body.bank_name !== undefined) {
      updatedMeta.bank_name = normalizeText(body.bank_name, "");
    }
    if (body.bank_account_number !== undefined) {
      updatedMeta.bank_account_number = normalizeText(body.bank_account_number, "");
    }
  }

  // Only the employee portal sends address/cp_number — other roles' settings
  // modals have no such fields, so an absent value must leave whatever's on
  // file untouched rather than getting wiped by an implicit empty string.
  if (body.address !== undefined) {
    updatedMeta.address = normalizeText(body.address, "");
  }
  if (body.cp_number !== undefined) {
    updatedMeta.cp_number = normalizeDigits(body.cp_number, 11);
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: updatedMeta,
  });

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  invalidateUsersCache();

  // profiles is authoritative for cp_number (see
  // supabase/migrations/20260910010000_transfer_requests_and_employee_contact.sql)
  // — every employee-listing route reads it from there, not user_metadata.
  const profilePatch = { full_name };
  if (nameParts) {
    profilePatch.first_name = nameParts.first_name;
    profilePatch.middle_name = nameParts.middle_name || null;
    profilePatch.last_name = nameParts.last_name;
    profilePatch.suffix = nameParts.suffix || null;
  }
  if (body.cp_number !== undefined) {
    profilePatch.cp_number = updatedMeta.cp_number || null;
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
      bank_name: updatedMeta.bank_name,
      bank_account_number: updatedMeta.bank_account_number,
    },
  });
}
