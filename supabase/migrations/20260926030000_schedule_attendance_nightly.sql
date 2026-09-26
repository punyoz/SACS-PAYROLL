-- ═══════════════════════════════════════════════════════════════════════════
-- Nightly attendance close, scheduled inside the database
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every night at 00:05 Asia/Manila (16:05 UTC; pg_cron runs in UTC) this runs
-- public.attendance_close_days() for the last 7 days up to yesterday:
-- missed tap-outs become Incomplete, and working days with no tap and no
-- approved leave get an Absent record. The 7-day window also catches a night
-- that was missed. The function is idempotent.
--
-- The job calls the database function directly rather than the
-- attendance-nightly Edge Function over HTTP, so no service-role key has to
-- be stored in the database. The Edge Function remains for on-demand runs.
--
-- cron.schedule() with a job name updates the job if it already exists, so
-- this is safe to run more than once.

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'attendance-nightly-close',
  '5 16 * * *',
  $$SELECT public.attendance_close_days(
      ((NOW() AT TIME ZONE 'Asia/Manila')::DATE - 7),
      ((NOW() AT TIME ZONE 'Asia/Manila')::DATE - 1)
    );$$
);
