/**
 * Plain-language sign-in errors.
 *
 * Supabase Auth returns its own wording ("Invalid login credentials", "Email
 * not confirmed", "For security purposes, you can only request this after 27
 * seconds"), which the login screen used to show verbatim — see
 * public/legacy/js/app.js, which alerts `result.error` as it arrives. This maps
 * those onto messages a payroll clerk can act on.
 *
 * ENUMERATION
 * A wrong email and a wrong password both return the same sentence. Telling the
 * two apart would let someone probe which addresses hold accounts, so the
 * generic message is also the fallback for any auth failure we do not
 * recognise — the safe direction when in doubt.
 *
 * Genuine outages are the one case worth distinguishing: a 5xx from Supabase is
 * not the user's password being wrong, and saying so sends them into a loop of
 * retyping a password that was right all along.
 */

export const GENERIC_CREDENTIALS_MESSAGE = "Incorrect email or password.";
export const UNCONFIRMED_EMAIL_MESSAGE = "Please confirm your email before logging in.";
export const RATE_LIMITED_MESSAGE = "Too many attempts. Please try again in a few minutes.";
export const SERVICE_UNAVAILABLE_MESSAGE = "Unable to sign in right now. Please try again in a moment.";

/**
 * @param {{ code?: string, status?: number, message?: string } | null} error
 *        the error object from supabase.auth.signInWithPassword()
 * @returns {string} a message safe to show the user as-is
 */
export function friendlyLoginError(error) {
  if (!error) return GENERIC_CREDENTIALS_MESSAGE;

  const code = String(error.code || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  const status = Number(error.status) || 0;

  // GoTrue sets code on newer releases; the message check keeps this working
  // against older ones, which sent the text only.
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return UNCONFIRMED_EMAIL_MESSAGE;
  }

  if (
    status === 429
    || code === "over_request_rate_limit"
    || code === "over_email_send_rate_limit"
    || message.includes("rate limit")
    || message.includes("you can only request this after")
  ) {
    return RATE_LIMITED_MESSAGE;
  }

  // Supabase itself is down or erroring — not a credentials problem.
  if (status >= 500) {
    return SERVICE_UNAVAILABLE_MESSAGE;
  }

  // invalid_credentials, user_not_found, and anything unrecognised.
  return GENERIC_CREDENTIALS_MESSAGE;
}
