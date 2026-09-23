/**
 * Which roles must clear an emailed code before a session is issued.
 *
 * Sign-in is two steps for some roles and one for others, and this is the only
 * place that decides which. POST /api/legacy-auth/login asks this question
 * once, right after the password checks out:
 *
 *   requiresLoginOtp(role) === true   ->  email a code, issue only the signed
 *                                         pending-login cookie, and wait for
 *                                         POST /api/legacy-auth/verify-login-otp
 *   requiresLoginOtp(role) === false  ->  finish the sign-in immediately
 *                                         (src/lib/auth/complete-login.js)
 *
 * The OTP machinery itself is untouched by a role sitting outside this set --
 * the verify and resend routes, the throttle and the verification screen all
 * stay in place for the roles that do use it. This is a routing decision, not
 * a removal.
 *
 * TO PUT A ROLE BACK BEHIND THE SECOND FACTOR: add it to this array. Nothing
 * else needs to change; both routes and the login screen read the answer from
 * here. Re-enabling for every role is OTP_REQUIRED_ROLES = [...KNOWN_ROLES].
 *
 * WHY THESE TWO. Employee and Accountant sign in from shared and personal
 * devices across branches, and their accounts are the ones whose passwords are
 * most exposed. Super Admin, Admin and HR are exempt at the operator's
 * request. Worth stating plainly: those three are the *highest* privilege
 * roles in the system -- they mint accounts and reach payroll -- so exempting
 * them is a deliberate trade of security for speed at a small number of desks,
 * not a security improvement. That is why re-enabling is kept to one line.
 */

/** Roles that must pass the emailed second factor. */
export const OTP_REQUIRED_ROLES = ["employee", "accountant"];

/**
 * @param {string} role a role string, in any casing
 * @returns {boolean} true when this role's sign-in needs the emailed code
 */
export function requiresLoginOtp(role) {
  return OTP_REQUIRED_ROLES.includes(String(role || "").toLowerCase());
}
