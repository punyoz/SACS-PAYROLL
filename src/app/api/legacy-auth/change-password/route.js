/**
 * POST /api/legacy-auth/change-password
 *
 * Changes the signed-in account's own password. Used both by each portal's
 * Account Settings and by the mandatory first-sign-in screen that replaces an
 * issued default password.
 *
 * The account is always the one in the signed session cookie. The old route
 * took an email from the request body and refused Admin accounts outright —
 * which would have left an Admin created with a default password unable to
 * ever get past the mandatory change.
 *
 * Employee and Accountant accounts (src/lib/auth/otp-policy.js) must first
 * clear the emailed-code steps at POST /api/legacy-auth/change-password-otp
 * (current password, then the 6-digit OTP). This route checks the signed
 * "verified" cookie those steps leave (src/lib/auth/password-otp.js) and
 * refuses without it. The grant is tied to the account's password_changed_at,
 * which this route updates, so one verification changes the password once.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { reissueSession } from "@/lib/rbac/session";
import { validateNewPassword } from "@/lib/auth/password-policy";
import { invalidateUsersCache } from "@/lib/auth/users-cache";
import { requiresLoginOtp } from "@/lib/auth/otp-policy";
import {
  clearPasswordOtpState,
  passwordChangedMarker,
  readPasswordOtpState,
} from "@/lib/auth/password-otp";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function POST(request) {
  const guard = await requirePermission(request, "profile", "update");
  if (guard.denied) return guard.denied;

  try {
    const body = await request.json().catch(() => ({}));
    const email = String(guard.session?.email || "").trim().toLowerCase();
    // Passwords are compared exactly as typed; sign-in trims its input, so the
    // same is done here to keep the two consistent.
    const currentPassword = String(body.current_password ?? "").trim();
    const newPassword = String(body.new_password ?? "").trim();
    const confirmPassword = body.confirm_password === undefined
      ? newPassword
      : String(body.confirm_password ?? "").trim();

    if (!email) {
      return NextResponse.json({ error: "Unable to identify your account. Please sign in again." }, { status: 400 });
    }
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: "Current password and new password are required." }, { status: 400 });
    }
    if (newPassword !== confirmPassword) {
      return NextResponse.json({ error: "New passwords do not match." }, { status: 400 });
    }
    if (!projectUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    // Verify the current password against the account itself.
    const authClient = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    // 400, not 401: the portals treat a 401 from the API as "session over"
    // and sign the user out, which a mistyped password must not do.
    if (signInError || !signInData?.user || signInData.user.id !== guard.userId) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
    }
    await authClient.auth.signOut();

    const user = signInData.user;
    const adminClient = createClient(projectUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let fullName = user.user_metadata?.full_name;
    const profileResult = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    if (!profileResult.error && profileResult.data?.full_name) {
      fullName = profileResult.data.full_name;
    }

    const policyError = validateNewPassword(newPassword, {
      currentPassword,
      full_name: fullName,
      date_of_birth: user.user_metadata?.date_of_birth,
    });
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
    }

    if (requiresLoginOtp(guard.role)) {
      const grant = readPasswordOtpState(request, "change");
      const verified = grant?.stage === "verified"
        && grant.sub === user.id
        && grant.pca === passwordChangedMarker(user);
      if (!verified) {
        return clearPasswordOtpState(
          NextResponse.json(
            { error: "Verify the OTP sent to your email before setting a new password.", code: "otp_not_verified" },
            { status: 400 },
          ),
          "change",
        );
      }
    }

    // temp_password_hash: null removes the one-time-password marker, so this
    // account is never forced back to the change-password screen by it again.
    const { error: updateError } = await adminClient.auth.admin.updateUserById(user.id, {
      password: newPassword,
      app_metadata: { temp_password_hash: null, password_changed_at: new Date().toISOString() },
    });
    if (updateError) {
      throw new Error(updateError.message);
    }
    invalidateUsersCache();

    // Same sign-in, same session id — only the "must change password" claim is
    // lifted, so the account is not signed out of the browser it is using.
    // The OTP grant (if any) is spent: clear it along with the reissue.
    return clearPasswordOtpState(
      reissueSession(
        NextResponse.json({ success: true, must_change_password: false, message: "Password updated successfully." }),
        guard.session,
        { must_change_password: false },
      ),
      "change",
    );
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
