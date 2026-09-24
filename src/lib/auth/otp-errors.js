/**
 * Plain-language messages for Supabase Auth email-OTP failures.
 *
 * Used by the password reset and change routes (signInWithOtp / verifyOtp).
 *
 * Supabase reports three kinds of trouble this separates out:
 *   - the per-address cooldown: "For security purposes, you can only request
 *     this after 42 seconds." (one email per 60 seconds by default)
 *   - the project-wide hourly email cap (over_email_send_rate_limit)
 *   - the mailer failing outright (custom SMTP / Brevo rejected the send)
 * A wrong code and an expired code are both otp_expired and are reported as
 * one message: Supabase does not say which, and neither does this.
 */

export const OTP_CODE_ERROR = "The OTP is incorrect or has expired. Check the code or request a new one.";

/**
 * @param {{ status?: number, code?: string, message?: string } | null} error
 * @param {"send" | "verify"} stage
 * @returns {{ status: number, code: string, retryAfter: number, error: string }}
 */
export function describeOtpError(error, stage) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status) || 0;

  const wait = /after (\d+) seconds?/.exec(message);
  if (wait) {
    const seconds = Number(wait[1]);
    return {
      status: 429,
      code: "otp_cooldown",
      retryAfter: seconds,
      error: `Please wait ${seconds} second${seconds === 1 ? "" : "s"} before requesting another OTP.`,
    };
  }

  if (code === "over_email_send_rate_limit" || message.includes("email rate limit")) {
    return {
      status: 429,
      code: "email_rate_limit",
      retryAfter: 3600,
      error: "The hourly email limit has been reached. Please try again later.",
    };
  }

  if (status === 429 || code === "over_request_rate_limit" || message.includes("rate limit")) {
    return {
      status: 429,
      code: "rate_limited",
      retryAfter: 60,
      error: "Too many requests. Please wait a minute and try again.",
    };
  }

  if (stage === "verify") {
    return { status: 400, code: "otp_invalid", retryAfter: 0, error: OTP_CODE_ERROR };
  }

  return {
    status: 502,
    code: "email_send_failed",
    retryAfter: 0,
    error: "We couldn't send the OTP email right now. Please try again in a few minutes or contact the administrator.",
  };
}

/** Seconds between OTP sends, matching Supabase's default per-address limit. */
export const OTP_RESEND_SECONDS = 60;
