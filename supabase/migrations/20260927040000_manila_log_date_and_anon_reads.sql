-- ═══════════════════════════════════════════════════════════════════════════
-- Manila-day default for attendance_logs.log_date; anon loses table reads
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. log_date defaulted to CURRENT_DATE, which is the database's UTC date.
--    The API always sets log_date explicitly, but any insert that relied on
--    the default between 00:00 and 08:00 Manila time was filed under the
--    previous day. The default is now the Manila calendar date, matching
--    every date key the app computes.
--
-- 2. The anon role (a browser holding only the public anon key, signed in as
--    nobody) still held SELECT on every public table. Row-level security
--    already returned nothing to it -- every policy is TO authenticated --
--    but nothing in this app reads tables as anon, so the grant is removed
--    outright rather than left for a future policy mistake to expose. The
--    default privileges are changed too, so a new table does not get it back.
--
-- Safe to run more than once.

ALTER TABLE public.attendance_logs
  ALTER COLUMN log_date SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::DATE);

REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT ON TABLES FROM anon;
