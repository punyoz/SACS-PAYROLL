-- ═══════════════════════════════════════════════════════════════════════════
-- Raw RFID taps: every tap kept, no cooldown, first tap in / last tap out
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now a tap within a minute of the previous one was ignored and only the
-- day's first and last tap survived (on attendance_logs). Every tap is now
-- accepted and stored as its own row in attendance_taps, which nothing may
-- update or delete. The day's attendance_logs row is still one per employee
-- per day, rebuilt by the API on each tap: Time In = first tap, Time Out =
-- last tap (src/lib/attendance/taps.js); the status engine then recomputes
-- hours, late, undertime and status as before.
--
-- A day HR / Admin corrected keeps its corrected times. A tap after the
-- correction is stored here and stamps attendance_logs.tap_after_correction_at
-- ("New tap after correction"), which the next approved correction of that
-- day clears.
--
-- attendance_blocked_taps now also keeps taps refused for an unregistered
-- card (no employee), an inactive employee or another branch's card, so its
-- employee_id may be NULL.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.attendance_taps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES public.profiles(id),
  employee_name TEXT,
  branch_id     UUID REFERENCES public.branches(id),
  log_date      DATE NOT NULL,
  tapped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rfid_uid      TEXT,
  device        TEXT,
  source        TEXT NOT NULL DEFAULT 'rfid_tap' CHECK (source IN ('rfid_tap', 'manual_entry')),
  recorded_by   UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attendance_taps_employee_day_idx ON public.attendance_taps (employee_id, log_date, tapped_at);
CREATE INDEX IF NOT EXISTS attendance_taps_date_idx ON public.attendance_taps (log_date);
CREATE INDEX IF NOT EXISTS attendance_taps_branch_idx ON public.attendance_taps (branch_id);

-- Written and read by the server (service role) only.
ALTER TABLE public.attendance_taps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_taps FROM anon, authenticated;

-- Append-only: a raw tap is evidence, never edited or removed.
CREATE OR REPLACE FUNCTION public.attendance_taps_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Raw attendance taps cannot be changed or deleted.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_taps_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS attendance_taps_append_only ON public.attendance_taps;
CREATE TRIGGER attendance_taps_append_only
  BEFORE UPDATE OR DELETE ON public.attendance_taps
  FOR EACH ROW EXECUTE FUNCTION public.attendance_taps_append_only();

-- "New tap after correction".
ALTER TABLE public.attendance_logs
  ADD COLUMN IF NOT EXISTS tap_after_correction_at TIMESTAMPTZ;

-- Refused taps without an employee (unregistered card).
ALTER TABLE public.attendance_blocked_taps ALTER COLUMN employee_id DROP NOT NULL;

-- A new approved correction means HR has reviewed the day: clear the flag.
CREATE OR REPLACE FUNCTION public.attendance_corrections_clear_tap_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.resolution = 'corrected' THEN
    UPDATE public.attendance_logs
    SET tap_after_correction_at = NULL
    WHERE id = NEW.log_id AND tap_after_correction_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_corrections_clear_tap_flag() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS attendance_corrections_clear_tap_flag ON public.attendance_corrections;
CREATE TRIGGER attendance_corrections_clear_tap_flag
  AFTER INSERT OR UPDATE OF status ON public.attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION public.attendance_corrections_clear_tap_flag();
