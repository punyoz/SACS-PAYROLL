-- ═══════════════════════════════════════════════════════════════════════════
-- Emailed one-time codes, issued and checked by the app (Nodemailer + Gmail)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Sign-in, password reset and password change used Supabase Auth's own email
-- OTP (signInWithOtp / verifyOtp). The app now generates the 6-digit code
-- itself, emails it through Gmail (src/lib/mail/gmail.js), and keeps only an
-- HMAC of it here (src/lib/auth/email-otp.js).
--
-- One row per flow and account ("login:<user id>", "reset:<user id>",
-- "pwchange:<user id>"), so a code sent for one flow never works in another.
-- A new code replaces the old row, which retires the old code.
--
-- Rules enforced here, atomically (row lock), so they hold across every
-- server instance:
--   - the code expires p_ttl_seconds after it is sent (the app uses 300)
--   - a new code cannot be sent within p_cooldown_seconds of the last one
--     while that one is still usable (the app uses 60)
--   - at most p_max_attempts wrong guesses per code (the app uses 5)
--   - a correct code is deleted on use: single-use
--
-- Additive only: no existing table changes. Only the service role may use it.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.auth_email_otps (
  key        TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.auth_email_otps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_email_otps FROM anon, authenticated;

-- Store a new code for p_key. Returns 0 when stored, or the seconds left in
-- the resend cooldown when the previous code is still usable and was sent
-- less than p_cooldown_seconds ago (nothing is stored then).
CREATE OR REPLACE FUNCTION public.auth_email_otp_issue(
  p_key TEXT,
  p_hash TEXT,
  p_ttl_seconds INTEGER,
  p_cooldown_seconds INTEGER,
  p_max_attempts INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row public.auth_email_otps;
  v_wait NUMERIC;
BEGIN
  SELECT * INTO v_row FROM public.auth_email_otps WHERE key = p_key FOR UPDATE;

  IF FOUND
     AND v_row.expires_at > NOW()
     AND v_row.attempts < p_max_attempts THEN
    v_wait := EXTRACT(EPOCH FROM (v_row.sent_at + make_interval(secs => p_cooldown_seconds) - NOW()));
    IF v_wait > 0 THEN
      RETURN CEIL(v_wait)::INTEGER;
    END IF;
  END IF;

  INSERT INTO public.auth_email_otps AS t (key, code_hash, expires_at, attempts, sent_at)
  VALUES (p_key, p_hash, NOW() + make_interval(secs => p_ttl_seconds), 0, NOW())
  ON CONFLICT (key) DO UPDATE
    SET code_hash  = EXCLUDED.code_hash,
        expires_at = EXCLUDED.expires_at,
        attempts   = 0,
        sent_at    = EXCLUDED.sent_at;

  -- Occasional housekeeping so the table does not grow without bound.
  IF random() < 0.05 THEN
    DELETE FROM public.auth_email_otps WHERE expires_at < NOW() - INTERVAL '1 day';
  END IF;

  RETURN 0;
END;
$$;

-- Check a code for p_key. Returns one of:
--   'ok'       correct; the code is deleted (single-use)
--   'invalid'  wrong; one attempt counted, more remain
--   'locked'   wrong too many times (p_max_attempts); a new code is needed
--   'expired'  past its expiry, or no code was sent
CREATE OR REPLACE FUNCTION public.auth_email_otp_verify(
  p_key TEXT,
  p_hash TEXT,
  p_max_attempts INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row public.auth_email_otps;
BEGIN
  SELECT * INTO v_row FROM public.auth_email_otps WHERE key = p_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'expired';
  END IF;

  IF v_row.expires_at <= NOW() THEN
    DELETE FROM public.auth_email_otps WHERE key = p_key;
    RETURN 'expired';
  END IF;

  IF v_row.attempts >= p_max_attempts THEN
    RETURN 'locked';
  END IF;

  IF v_row.code_hash = p_hash THEN
    DELETE FROM public.auth_email_otps WHERE key = p_key;
    RETURN 'ok';
  END IF;

  UPDATE public.auth_email_otps SET attempts = attempts + 1 WHERE key = p_key;
  IF v_row.attempts + 1 >= p_max_attempts THEN
    RETURN 'locked';
  END IF;
  RETURN 'invalid';
END;
$$;

-- Throw a code away (its email could not be sent).
CREATE OR REPLACE FUNCTION public.auth_email_otp_discard(p_key TEXT)
RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
  DELETE FROM public.auth_email_otps WHERE key = p_key;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_email_otp_issue(TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auth_email_otp_verify(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auth_email_otp_discard(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_email_otp_issue(TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_email_otp_verify(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_email_otp_discard(TEXT) TO service_role;
