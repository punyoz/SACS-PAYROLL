-- RFID duplicate-tap window (alpha test C1, 2026-11-09).
--
-- The Super Admin sets how many seconds a second tap of the same card counts
-- as a double tap (system_config section 'attendance', key
-- 'duplicate_tap_seconds'): whole seconds from 3 to 10, default 5 (in code,
-- src/lib/attendance/taps.js; no row is added here). The terminal then shows
-- "Already recorded at 7:58 AM" and the audit log records rfid_duplicate_tap.
-- The 5-minute rule (a repeat is never a Time Out) is unchanged.
--
-- The API checks the value (PATCH /api/admin/config); the database refuses
-- any other value as well. Additive; no data is changed. Safe to run more
-- than once.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'system_config_duplicate_tap_seconds_range' AND conrelid = 'public.system_config'::regclass
  ) THEN
    ALTER TABLE public.system_config
      ADD CONSTRAINT system_config_duplicate_tap_seconds_range CHECK (
        section IS DISTINCT FROM 'attendance'
        OR key IS DISTINCT FROM 'duplicate_tap_seconds'
        OR value IN ('3', '4', '5', '6', '7', '8', '9', '10')
      );
  END IF;
END $$;
