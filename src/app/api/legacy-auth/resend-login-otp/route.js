import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { attachPendingLogin, readPendingLogin } from "@/lib/auth/pending-login";
import { checkResendAllowed, recordCodeSent } from "@/lib/auth/otp-throttle";
import { sanitizeError } from "@/lib/api-error";

/**
 * POST /api/legacy-auth/resend-login-otp
 *
 * Requests a fresh code for the sign-in already mid-flight, identified the
 * same way verify-login-otp is: the signed pending-login cookie, never a
 * client-supplied email. Supabase supersedes the previously issued code when
 * a new one is requested for the same address, so this is also how "the old
 * code stops working" (requirement 2.3) is satisfied — the app does not (and
 * cannot) hold or invalidate that code itself.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function handleResend(request) {
  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase env values are missing." }, { status: 500 });
  }

  const pending = readPendingLogin(request);
  if (!pending) {
    return NextResponse.json(
      { error: "Your sign-in session has expired. Please sign in again.", code: "pending_login_expired" },
      { status: 401 },
    );
  }

  const throttle = checkResendAllowed(pending.sub);
  if (!throttle.allowed) {
    return NextResponse.json(
      { error: `Please wait ${throttle.retryAfterSeconds}s before requesting another code.` },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
    );
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supabase.auth.signInWithOtp({
    email: pending.email,
    options: { shouldCreateUser: false },
  });

  if (error) {
    const rateLimited = Number(error.status) === 429
      || String(error.code || "").toLowerCase().includes("rate_limit");
    return NextResponse.json(
      {
        error: rateLimited
          ? "Too many verification codes requested. Please wait a few minutes and try again."
          : "Unable to send a new code right now. Please try again.",
      },
      { status: rateLimited ? 429 : 503 },
    );
  }

  // Starts the resend cooldown and resets the wrong-attempt counter — a fresh
  // code makes whatever was guessed against the old one moot.
  recordCodeSent(pending.sub);

  // Fresh 10-minute window to match the fresh code, without disturbing which
  // account or must_change_password state this pending sign-in belongs to.
  return attachPendingLogin(
    NextResponse.json({ success: true, message: "A new code has been sent." }),
    { user_id: pending.sub, email: pending.email, must_change_password: pending.pwd },
  );
}

export async function POST(request) {
  try {
    return await handleResend(request);
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, "Unable to send a new code right now. Please try again.") },
      { status: 500 },
    );
  }
}
