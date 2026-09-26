/**
 * The last step of a successful sign-in, shared by both routes that can reach
 * it.
 *
 * Two paths now end in a session: POST /api/legacy-auth/verify-login-otp once
 * an emailed code checks out, and POST /api/legacy-auth/login directly, for
 * the roles src/lib/auth/otp-policy.js exempts from the second factor. What
 * has to happen at that moment is identical either way -- register this as the
 * account's one active session, then issue the signed sacs-session cookie --
 * so it lives here rather than being written twice and drifting apart.
 *
 * Registering the active session is deliberately part of *this* step and not
 * of the password check. On the OTP path, doing it at the password step would
 * let someone who knows only the password sign the real user out of their
 * other browser without ever getting in themselves.
 */

import { NextResponse } from "next/server";
import { attachSession } from "@/lib/rbac/session";
import { newSessionId, registerActiveSession } from "@/lib/auth/active-session";
import { buildProfilePayload } from "@/lib/auth/resolve-profile-claims";
import { loadSecuritySettings } from "@/lib/auth/security-settings";

/** Where each role lands once signed in. */
export const ROLE_ROUTES = {
  super_admin: "/super-admin",
  admin: "/admin",
  accountant: "/accountant",
  employee: "/employee",
  hr: "/hr",
};

export const ARCHIVED_ACCOUNT_MESSAGE = "This account has been archived and can no longer sign in.";

/** True when the account's profiles row (resolveLoginProfile) is archived. */
export function isArchivedProfile(resolved) {
  return resolved?.profileRow?.archived === true;
}

/** True when `role` is one this app can route a sign-in to. */
export function isRoutableRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_ROUTES, String(role || "").toLowerCase());
}

/**
 * Register the active session and return the response carrying sacs-session.
 *
 * @param {object}  args
 * @param {string}  args.userId              Supabase Auth user id
 * @param {object}  args.resolved            result of resolveLoginProfile()
 * @param {boolean} args.mustChangePassword  still on the issued default
 * @param {(response: import("next/server").NextResponse) => import("next/server").NextResponse} [args.decorate]
 *        applied to the response before the cookie is attached -- used by the
 *        OTP path to clear its pending-login cookie in the same response.
 * @returns {Promise<import("next/server").NextResponse>} the 200 with the
 *        session cookie, or a 503 when the session could not be registered.
 */
export async function completeLogin({ userId, resolved, mustChangePassword, decorate }) {
  // profiles.archived is the copy the account holder cannot edit (their
  // user_metadata.archived they can). Checked here, where every session is
  // minted, so sign-in, the OTP step and password reset all honour it.
  if (isArchivedProfile(resolved)) {
    const refused = NextResponse.json(
      { error: ARCHIVED_ACCOUNT_MESSAGE },
      { status: 403 },
    );
    // Still clear the caller's pending OTP / reset state, as a success would.
    if (decorate) decorate(refused);
    return refused;
  }

  const sessionId = newSessionId();

  try {
    await registerActiveSession(userId, sessionId);
  } catch {
    return NextResponse.json(
      { error: "Unable to start your session right now. Please try again." },
      { status: 503 },
    );
  }

  const response = NextResponse.json({
    success: true,
    redirectTo: ROLE_ROUTES[resolved.resolvedRole],
    role: resolved.resolvedRole,
    must_change_password: mustChangePassword,
    profile: buildProfilePayload(resolved, mustChangePassword),
  });

  if (decorate) decorate(response);

  // The signed HttpOnly cookie every API guard reads. Issued here and nowhere
  // else for a fresh sign-in. It lapses after the Super Admin's Session
  // Timeout without activity (renewed by src/proxy.js), and 8 hours after
  // sign-in at the latest.
  const security = await loadSecuritySettings();
  return attachSession(response, {
    idle_seconds: security.session * 60,
    user_id: userId,
    role: resolved.resolvedRole,
    branch_id: resolved.resolvedBranchId,
    email: resolved.resolvedEmailOutput,
    full_name: resolved.resolvedFullName,
    session_id: sessionId,
    must_change_password: mustChangePassword,
  });
}
