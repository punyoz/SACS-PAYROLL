/**
 * Which roles must clear an emailed code before a session is issued.
 *
 * POST /api/legacy-auth/login asks this question once, right after the
 * password checks out:
 *
 *   requiresLoginOtp(role) === true   ->  email a code, issue only the signed
 *                                         pending-login cookie, and wait for
 *                                         POST /api/legacy-auth/verify-login-otp
 *   requiresLoginOtp(role) === false  ->  finish the sign-in immediately
 *                                         (src/lib/auth/complete-login.js)
 *
 * The same answer decides who uses the emailed code for Forgot Password
 * (src/lib/auth/password-otp.js canResetPassword) and Change Password
 * (/api/legacy-auth/change-password-otp, public/legacy/js/app.js).
 *
 * EVERY ROLE. Since 2026-10-07 Super Admin, Admin and HR sign in with the
 * emailed code too (the operator lifted the earlier exemption). Every account
 * therefore needs a real, reachable email address: an account whose address
 * cannot receive mail cannot sign in.
 *
 * TO EXEMPT A ROLE AGAIN: remove it from this array. Nothing else needs to
 * change; the routes, the login screen and the portals read the answer from
 * here.
 */

import { ROLES } from "@/lib/rbac/permissions";

/** Roles that must pass the emailed second factor. */
export const OTP_REQUIRED_ROLES = [...ROLES];

/**
 * @param {string} role a role string, in any casing
 * @returns {boolean} true when this role's sign-in needs the emailed code
 */
export function requiresLoginOtp(role) {
  return OTP_REQUIRED_ROLES.includes(String(role || "").toLowerCase());
}
