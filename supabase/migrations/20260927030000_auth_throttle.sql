-- ═══════════════════════════════════════════════════════════════════════════
-- Shared sign-in / OTP attempt counters
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The login and OTP brakes (src/lib/auth/login-throttle.js, otp-throttle.js)
-- count attempts in server memory. On Vercel every serverless instance has
-- its own memory and a cold start empties it, so an attacker spread across
-- instances -- or simply waiting for a cold start -- got a fresh budget.
--
-- These counters live in Postgres instead, so every instance shares them.
-- src/lib/auth/persistent-throttle.js calls the functions below alongside the
-- in-memory counters (which still answer instantly and keep working if the
-- database is unreachable).
--
-- Only the service role may use them.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.auth_throttle (
  key               TEXT PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0,
  window_expires_at TIMESTAMPTZ NOT NULL,
  locked_until      TIMESTAMPTZ
);

ALTER TABLE public.auth_throttle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_throttle FROM anon, authenticated;

-- Seconds until `p_key` may try again; 0 when it may try now. Reaching
-- p_max failures inside the window starts a lockout of p_lockout_seconds.
CREATE OR REPLACE FUNCTION public.auth_throttle_check(p_key TEXT, p_max INTEGER, p_lockout_seconds INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row public.auth_throttle;
BEGIN
  SELECT * INTO v_row FROM public.auth_throttle WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > NOW() THEN
    RETURN CEIL(EXTRACT(EPOCH FROM (v_row.locked_until - NOW())))::INTEGER;
  END IF;

  IF v_row.window_expires_at <= NOW() THEN
    RETURN 0;
  END IF;

  IF v_row.attempts >= p_max THEN
    UPDATE public.auth_throttle
       SET locked_until = NOW() + make_interval(secs => p_lockout_seconds),
           window_expires_at = GREATEST(window_expires_at, NOW() + make_interval(secs => p_lockout_seconds))
     WHERE key = p_key;
    RETURN p_lockout_seconds;
  END IF;

  RETURN 0;
END;
$$;

-- Count one failed attempt against `p_key`.
CREATE OR REPLACE FUNCTION public.auth_throttle_fail(p_key TEXT, p_window_seconds INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.auth_throttle AS t (key, attempts, window_expires_at)
  VALUES (p_key, 1, NOW() + make_interval(secs => p_window_seconds))
  ON CONFLICT (key) DO UPDATE
    SET attempts = CASE
          WHEN t.window_expires_at <= NOW() AND (t.locked_until IS NULL OR t.locked_until <= NOW()) THEN 1
          ELSE t.attempts + 1
        END,
        locked_until = CASE
          WHEN t.window_expires_at <= NOW() AND (t.locked_until IS NULL OR t.locked_until <= NOW()) THEN NULL
          ELSE t.locked_until
        END,
        window_expires_at = CASE
          WHEN t.window_expires_at <= NOW() AND (t.locked_until IS NULL OR t.locked_until <= NOW())
            THEN NOW() + make_interval(secs => p_window_seconds)
          ELSE t.window_expires_at
        END;

  -- Occasional housekeeping so the table does not grow without bound.
  IF random() < 0.02 THEN
    DELETE FROM public.auth_throttle
     WHERE window_expires_at < NOW() - INTERVAL '1 day'
       AND (locked_until IS NULL OR locked_until < NOW());
  END IF;
END;
$$;

-- Forget `p_key` (a successful sign-in / verification).
CREATE OR REPLACE FUNCTION public.auth_throttle_clear(p_key TEXT)
RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
  DELETE FROM public.auth_throttle WHERE key = p_key;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_throttle_check(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auth_throttle_fail(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auth_throttle_clear(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_throttle_check(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_throttle_fail(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_throttle_clear(TEXT) TO service_role;
