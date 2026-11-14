/**
 * The login page's password reset takes the registered email only
 * (2026-11-14): the dialog and POST /api/legacy-auth/reset-password share
 * these, so both refuse an Employee ID with the same plain message.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const RESET_EMAIL_REQUIRED = "Enter your email address.";
export const RESET_EMAIL_INVALID = "Enter a valid email address. Employee IDs are no longer accepted here.";

/** Trimmed; letter case does not matter (the lookup lowercases both sides). */
export function isResetEmail(value) {
  return EMAIL.test(String(value ?? "").trim());
}
