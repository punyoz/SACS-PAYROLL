-- Processing window enforcement: a Super Admin testing switch (2026-11-06,
-- user's request for testing and the final defense).
--
-- The processing window (Super Admin -> Payslip Schedule: the generation day
-- .. closes_on, and the attendance-override window inside it) is enforced by
-- the server (src/app/api/accountant/payroll/route.js, through
-- src/lib/payroll/window-enforcement.js). This switch lets the Super Admin
-- turn that one rule OFF for a while. Nothing else changes when it is OFF:
-- own branch only, government deductions and withholding tax read-only,
-- partial submission with acknowledgment, HR approval, nobody processes
-- their own payslip by hand, approved payroll locked, Final payslip override
-- Super Admin only.
--
--   public.payroll_window_enforcement           one row (id = 1); default ON
--   public.payroll_window_enforcement_changes   every change: who, when, old,
--                                               new, reason (append-only)
--   public.payroll_window_enforcement_state()   what the server reads; the
--                                               auto-expiry is checked HERE,
--                                               at read time, so a late or
--                                               missed cron job never leaves
--                                               it OFF past its date
--   public.set_payroll_window_enforcement(...)  the only way it changes
--   public.payroll_window_auto_expire()         daily pg_cron tidy-up: writes
--                                               the expiry into the row and
--                                               the change log
--   created_in_testing_mode                     on payroll_entries and
--                                               payroll_runs: set by the
--                                               database (never by a client)
--                                               on rows created or
--                                               reprocessed while it is OFF.
--                                               Existing rows stay FALSE.
--
-- Access: server (service role) only. No anon / authenticated policy, and
-- EXECUTE is revoked from them, so no portal user changes or reads it
-- directly. The API lets only the Super Admin change it.
--
-- Reverting: turn the switch ON (System Configuration). The window rules and
-- code were never removed; ON is exactly the previous behaviour.

-- ── 1. The setting ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_window_enforcement (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enforced         BOOLEAN NOT NULL DEFAULT TRUE,
  expires_on       DATE,                              -- while OFF: turns back ON on this Manila date
  reason           TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  changed_by       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_by_name  TEXT,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.payroll_window_enforcement (id, enforced) VALUES (1, TRUE)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.payroll_window_enforcement IS
  'Processing window enforcement (Super Admin testing switch). ON = the processing window is enforced (normal). Read through payroll_window_enforcement_state().';

CREATE TABLE IF NOT EXISTS public.payroll_window_enforcement_changes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  old_enforced     BOOLEAN,
  new_enforced     BOOLEAN NOT NULL,
  old_expires_on   DATE,
  new_expires_on   DATE,
  reason           TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  source           TEXT NOT NULL DEFAULT 'super_admin' CHECK (source IN ('super_admin', 'auto_expiry', 'seed')),
  environment      TEXT CHECK (environment IS NULL OR char_length(environment) <= 40),
  actor_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_name       TEXT,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_window_enforcement_changes_at_idx
  ON public.payroll_window_enforcement_changes (changed_at DESC);
CREATE INDEX IF NOT EXISTS payroll_window_enforcement_changes_actor_idx
  ON public.payroll_window_enforcement_changes (actor_id);

-- The change log is never edited or deleted.
CREATE OR REPLACE FUNCTION public.payroll_window_enforcement_changes_keep()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Processing window enforcement changes are never changed or deleted.'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS payroll_window_enforcement_changes_keep ON public.payroll_window_enforcement_changes;
CREATE TRIGGER payroll_window_enforcement_changes_keep
  BEFORE UPDATE OR DELETE ON public.payroll_window_enforcement_changes
  FOR EACH ROW EXECUTE FUNCTION public.payroll_window_enforcement_changes_keep();

-- The setting row is never deleted (a missing row would read as ON anyway).
CREATE OR REPLACE FUNCTION public.payroll_window_enforcement_keep()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'The processing window enforcement setting is never deleted: turn it ON instead.'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS payroll_window_enforcement_keep ON public.payroll_window_enforcement;
CREATE TRIGGER payroll_window_enforcement_keep
  BEFORE DELETE ON public.payroll_window_enforcement
  FOR EACH ROW EXECUTE FUNCTION public.payroll_window_enforcement_keep();

-- ── 2. Reading it (auto-expiry checked at read time) ───────────────────────

-- TRUE = the window is enforced. Fails safe: no row = ON; OFF with an
-- expiry date that has arrived (Asia/Manila) = ON, whether or not the daily
-- job has run yet.
CREATE OR REPLACE FUNCTION public.payroll_window_enforced()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT e.enforced
        OR (e.expires_on IS NOT NULL AND e.expires_on <= (NOW() AT TIME ZONE 'Asia/Manila')::DATE)
    FROM public.payroll_window_enforcement e
    WHERE e.id = 1
  ), TRUE);
$$;

CREATE OR REPLACE FUNCTION public.payroll_window_enforcement_state()
RETURNS TABLE (
  enforced         BOOLEAN,   -- what the server applies (expiry included)
  stored_enforced  BOOLEAN,   -- the row as saved
  expired          BOOLEAN,   -- OFF in the row, but its expiry date has arrived
  expires_on       DATE,
  reason           TEXT,
  changed_by_name  TEXT,
  changed_at       TIMESTAMPTZ,
  today            DATE
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH t AS (SELECT (NOW() AT TIME ZONE 'Asia/Manila')::DATE AS d),
  row1 AS (SELECT e.* FROM public.payroll_window_enforcement e WHERE e.id = 1)
  SELECT
    COALESCE(r.enforced OR (r.expires_on IS NOT NULL AND r.expires_on <= t.d), TRUE),
    COALESCE(r.enforced, TRUE),
    COALESCE(NOT r.enforced AND r.expires_on IS NOT NULL AND r.expires_on <= t.d, FALSE),
    r.expires_on,
    r.reason,
    r.changed_by_name,
    r.changed_at,
    t.d
  FROM t LEFT JOIN row1 r ON TRUE;
$$;

-- ── 3. Changing it (the only way; the API calls it for the Super Admin) ────

CREATE OR REPLACE FUNCTION public.set_payroll_window_enforcement(
  p_enforced     BOOLEAN,
  p_expires_on   DATE,
  p_reason       TEXT,
  p_actor        UUID,
  p_actor_name   TEXT,
  p_source       TEXT DEFAULT 'super_admin',
  p_environment  TEXT DEFAULT NULL
)
RETURNS SETOF public.payroll_window_enforcement
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_old    public.payroll_window_enforcement%ROWTYPE;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
  v_expiry DATE := CASE WHEN p_enforced THEN NULL ELSE p_expires_on END;
BEGIN
  IF p_enforced IS NULL THEN
    RAISE EXCEPTION 'Choose ON or OFF.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reason is required.' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason can be at most 500 characters.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_expiry IS NOT NULL AND v_expiry <= v_today THEN
    RAISE EXCEPTION 'The automatic return to ON must be a future date.' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(p_source, '') NOT IN ('super_admin', 'auto_expiry', 'seed') THEN
    RAISE EXCEPTION 'Unknown source.' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.payroll_window_enforcement (id, enforced) VALUES (1, TRUE)
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v_old FROM public.payroll_window_enforcement WHERE id = 1 FOR UPDATE;

  UPDATE public.payroll_window_enforcement SET
    enforced        = p_enforced,
    expires_on      = v_expiry,
    reason          = v_reason,
    changed_by      = p_actor,
    changed_by_name = p_actor_name,
    changed_at      = NOW()
  WHERE id = 1;

  INSERT INTO public.payroll_window_enforcement_changes
    (old_enforced, new_enforced, old_expires_on, new_expires_on, reason, source, environment, actor_id, actor_name)
  VALUES
    (v_old.enforced, p_enforced, v_old.expires_on, v_expiry, v_reason, p_source, p_environment, p_actor, p_actor_name);

  RETURN QUERY SELECT * FROM public.payroll_window_enforcement WHERE id = 1;
END;
$$;

-- Daily tidy-up: an OFF switch whose date has arrived is written back ON and
-- logged. The read-time check above already treats it as ON before this runs.
CREATE OR REPLACE FUNCTION public.payroll_window_auto_expire()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::DATE;
  v_row   public.payroll_window_enforcement%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.payroll_window_enforcement WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR v_row.enforced OR v_row.expires_on IS NULL OR v_row.expires_on > v_today THEN
    RETURN FALSE;
  END IF;
  UPDATE public.payroll_window_enforcement SET
    enforced = TRUE, expires_on = NULL,
    reason = format('Automatic: testing mode ended on %s.', v_row.expires_on),
    changed_by = NULL, changed_by_name = 'System (automatic)', changed_at = NOW()
  WHERE id = 1;
  INSERT INTO public.payroll_window_enforcement_changes
    (old_enforced, new_enforced, old_expires_on, new_expires_on, reason, source, actor_name)
  VALUES
    (FALSE, TRUE, v_row.expires_on, NULL, format('Automatic: testing mode ended on %s.', v_row.expires_on), 'auto_expiry', 'System (automatic)');
  RETURN TRUE;
END;
$$;

-- 00:01 Manila daily (16:01 UTC).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('payroll-window-auto-expire', '1 16 * * *', 'SELECT public.payroll_window_auto_expire();');
  END IF;
END;
$$;

-- ── 4. "Created in testing mode" flags (new rows only) ─────────────────────

ALTER TABLE public.payroll_entries
  ADD COLUMN IF NOT EXISTS created_in_testing_mode BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS created_in_testing_mode BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.payroll_entries.created_in_testing_mode IS
  'Set by the database: the payslip was created or recomputed while processing window enforcement was OFF. Never cleared.';
COMMENT ON COLUMN public.payroll_runs.created_in_testing_mode IS
  'Set by the database: the run was created or submitted while processing window enforcement was OFF. Never cleared.';

CREATE INDEX IF NOT EXISTS payroll_entries_testing_mode_idx
  ON public.payroll_entries (pay_period) WHERE created_in_testing_mode;
CREATE INDEX IF NOT EXISTS payroll_runs_testing_mode_idx
  ON public.payroll_runs (period_start) WHERE created_in_testing_mode;

-- A payslip: marked when created, or when its figures are recomputed by the
-- Accountant (not by submit / approve / reject / the Super Admin's override,
-- which run with payroll_run_action_on()), while the switch is OFF. A client
-- can never set or clear the flag itself.
CREATE OR REPLACE FUNCTION public.payroll_entries_testing_mark()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_in_testing_mode := NOT public.payroll_window_enforced();
  ELSE
    NEW.created_in_testing_mode := OLD.created_in_testing_mode
      OR (NEW.payroll IS DISTINCT FROM OLD.payroll
          AND NOT public.payroll_run_action_on()
          AND NOT public.payroll_window_enforced());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_entries_testing_mark ON public.payroll_entries;
CREATE TRIGGER payroll_entries_testing_mark
  BEFORE INSERT OR UPDATE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_testing_mark();

-- A run: marked when created, or submitted to HR, while the switch is OFF.
CREATE OR REPLACE FUNCTION public.payroll_runs_testing_mark()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_in_testing_mode := NOT public.payroll_window_enforced();
  ELSE
    NEW.created_in_testing_mode := OLD.created_in_testing_mode
      OR (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending'
          AND NOT public.payroll_window_enforced());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_runs_testing_mark ON public.payroll_runs;
CREATE TRIGGER payroll_runs_testing_mark
  BEFORE INSERT OR UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_testing_mark();

-- The runs view the screens read (last defined in 20261029080000), the same
-- columns plus the flag at the end, so HR sees which runs were made in
-- testing mode.
CREATE OR REPLACE VIEW public.payroll_run_summaries AS
 SELECT r.id,
    r.branch_id,
    b.name AS branch_name,
    r.period_label,
    r.period_start,
    r.period_end,
    r.cutoff_type,
    r.status,
    r.submission_no,
    r.processed_by,
    r.processed_by_name,
    r.submitted_by,
    r.submitted_by_name,
    r.submitted_at,
    r.reviewed_by,
    r.reviewed_by_name,
    r.reviewed_at,
    r.remarks,
    r.total_employees,
    r.total_gross,
    r.total_deductions,
    r.total_net,
    r.created_at,
    r.updated_at,
    ( SELECT count(*) AS count
           FROM payroll_run_items i
          WHERE ((i.run_id = r.id) AND (i.submission_no = r.submission_no) AND (cardinality(i.flags) > 0))) AS flagged_employees,
    r.run_no,
    ( SELECT count(*) AS count
           FROM payroll_run_exclusions x
          WHERE ((x.run_id = r.id) AND (x.submission_no = r.submission_no))) AS excluded_employees,
    r.created_in_testing_mode
   FROM (payroll_runs r
     LEFT JOIN branches b ON ((b.id = r.branch_id)));

REVOKE ALL ON public.payroll_run_summaries FROM anon, authenticated;

-- ── 5. Access: server only ─────────────────────────────────────────────────

ALTER TABLE public.payroll_window_enforcement         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_window_enforcement_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payroll_window_enforcement         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payroll_window_enforcement_changes FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS payroll_window_enforcement_no_client ON public.payroll_window_enforcement;
CREATE POLICY payroll_window_enforcement_no_client ON public.payroll_window_enforcement
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);
DROP POLICY IF EXISTS payroll_window_enforcement_changes_no_client ON public.payroll_window_enforcement_changes;
CREATE POLICY payroll_window_enforcement_changes_no_client ON public.payroll_window_enforcement_changes
  FOR ALL TO anon, authenticated USING (FALSE) WITH CHECK (FALSE);

REVOKE EXECUTE ON FUNCTION public.payroll_window_enforced() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_window_enforcement_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_payroll_window_enforcement(BOOLEAN, DATE, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_window_auto_expire() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_window_enforcement_changes_keep() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_window_enforcement_keep() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_entries_testing_mark() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_runs_testing_mark() FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.payroll_window_enforcement TO service_role;
GRANT SELECT, INSERT ON public.payroll_window_enforcement_changes TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_window_enforced() TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_window_enforcement_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.set_payroll_window_enforcement(BOOLEAN, DATE, TEXT, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_window_auto_expire() TO service_role;
