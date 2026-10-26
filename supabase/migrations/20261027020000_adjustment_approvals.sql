-- Incentives, overload and loans (incl. cash advances) need HR approval
-- before payroll uses them (decision 2026-10-27; the rule "adjustments are
-- approved in their own module before computation").
--
--   Accountant files  ─►  pending  ─►  HR approves  ─►  approved (payroll uses it)
--                                  └►  HR rejects   ─►  rejected (kept; never paid)
--
--   * payroll_monthly_incentives and payroll_loans gain approval_status
--     (pending / approved / rejected) and who decided, when, and the note.
--     Existing rows, and rows the database itself writes after an HR approval
--     (payroll corrections, subsidy advances), stay 'approved' (the default).
--   * An Accountant's new row must be 'pending' (payroll_adjustment_insert_guard);
--     only HR (or the Super Admin, for a branch Admin's recommendation it
--     approves in Branch Requests) adds a row already approved.
--   * Only payroll_adjustment_decide() changes the approval, and it accepts
--     an active HR account only; a rejection needs a reason. Nothing is deleted.
--   * Payroll reads only approved rows; an incentive counts toward the payroll
--     month of its approval date when that is later than its filing date.
--
-- Additive. Safe to run more than once.

ALTER TABLE public.payroll_monthly_incentives
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS decided_by_name TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note TEXT;
ALTER TABLE public.payroll_loans
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS decided_by_name TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_monthly_incentives_approval_status_check') THEN
    ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_loans_approval_status_check') THEN
    ALTER TABLE public.payroll_loans ADD CONSTRAINT payroll_loans_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_pending_idx ON public.payroll_monthly_incentives (created_at) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS payroll_loans_pending_idx ON public.payroll_loans (created_at) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS payroll_monthly_incentives_decided_by_idx ON public.payroll_monthly_incentives (decided_by);
CREATE INDEX IF NOT EXISTS payroll_loans_decided_by_idx ON public.payroll_loans (decided_by);

-- Inserts by the app (service_role) and any client: an Accountant's row is
-- pending; a row already approved comes from HR (or the Super Admin). The
-- database's own functions (owner) are not affected.
CREATE OR REPLACE FUNCTION public.payroll_adjustment_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF current_user NOT IN ('service_role', 'authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.approval_status = 'pending' THEN
    NEW.decided_by := NULL; NEW.decided_by_name := NULL; NEW.decided_at := NULL; NEW.decision_note := NULL;
    RETURN NEW;
  END IF;
  SELECT p.role::TEXT INTO v_role FROM public.profiles p WHERE p.id = NEW.created_by AND NOT COALESCE(p.archived, false);
  IF NEW.approval_status <> 'approved' OR v_role IS NULL OR v_role NOT IN ('hr', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden: a new % waits for HR approval (approval_status pending).', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.decided_by := COALESCE(NEW.decided_by, NEW.created_by);
  NEW.decided_by_name := COALESCE(NEW.decided_by_name, NEW.created_by_name);
  NEW.decided_at := COALESCE(NEW.decided_at, NOW());
  RETURN NEW;
END;
$$;

-- The approval columns change only through payroll_adjustment_decide().
CREATE OR REPLACE FUNCTION public.payroll_adjustment_update_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('sacs.adjustment_decision', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF current_user IN ('service_role', 'authenticated', 'anon')
     AND (NEW.approval_status, NEW.decided_by, NEW.decided_by_name, NEW.decided_at, NEW.decision_note)
         IS DISTINCT FROM (OLD.approval_status, OLD.decided_by, OLD.decided_by_name, OLD.decided_at, OLD.decision_note) THEN
    RAISE EXCEPTION 'forbidden: only HR approves or rejects it (payroll_adjustment_decide).' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_monthly_incentives', 'payroll_loans'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_approval_insert_guard' AND tgrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_adjustment_insert_guard()', t || '_approval_insert_guard', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_approval_update_guard' AND tgrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_adjustment_update_guard()', t || '_approval_update_guard', t);
    END IF;
  END LOOP;
END $$;

-- HR's decision: p_kind 'incentive' (incentive / overload) or 'loan'.
CREATE OR REPLACE FUNCTION public.payroll_adjustment_decide(p_actor UUID, p_kind TEXT, p_id UUID, p_decision TEXT, p_note TEXT)
RETURNS TABLE (id UUID, employee_id UUID, approval_status TEXT, created_by UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_actor RECORD;
  v_status TEXT;
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_next TEXT;
BEGIN
  SELECT p.id, p.role::TEXT AS role, p.full_name, COALESCE(p.archived, false) AS archived INTO v_actor FROM public.profiles p WHERE p.id = p_actor;
  IF v_actor.id IS NULL OR v_actor.role <> 'hr' OR v_actor.archived THEN
    RAISE EXCEPTION 'forbidden: only HR approves or rejects incentives, overload and loans.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid: the decision is approve or reject.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'reject' AND length(COALESCE(v_note, '')) < 5 THEN
    RAISE EXCEPTION 'invalid: give the reason for rejecting it (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  v_next := CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END;

  PERFORM set_config('sacs.adjustment_decision', 'on', true);
  IF p_kind = 'incentive' THEN
    SELECT i.approval_status INTO v_status FROM public.payroll_monthly_incentives i WHERE i.id = p_id AND NOT i.archived FOR UPDATE;
    IF v_status IS NULL THEN RAISE EXCEPTION 'not_found: no such incentive or overload.' USING ERRCODE = 'no_data_found'; END IF;
    IF v_status <> 'pending' THEN RAISE EXCEPTION 'already_decided: it is already %.', v_status USING ERRCODE = 'unique_violation'; END IF;
    RETURN QUERY UPDATE public.payroll_monthly_incentives i
      SET approval_status = v_next, decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(), decision_note = v_note
      WHERE i.id = p_id RETURNING i.id, i.employee_id, i.approval_status, i.created_by;
  ELSIF p_kind = 'loan' THEN
    SELECT l.approval_status INTO v_status FROM public.payroll_loans l WHERE l.id = p_id FOR UPDATE;
    IF v_status IS NULL THEN RAISE EXCEPTION 'not_found: no such loan.' USING ERRCODE = 'no_data_found'; END IF;
    IF v_status <> 'pending' THEN RAISE EXCEPTION 'already_decided: it is already %.', v_status USING ERRCODE = 'unique_violation'; END IF;
    RETURN QUERY UPDATE public.payroll_loans l
      SET approval_status = v_next, decided_by = v_actor.id, decided_by_name = v_actor.full_name, decided_at = NOW(), decision_note = v_note
      WHERE l.id = p_id RETURNING l.id, l.employee_id, l.approval_status, l.created_by;
  ELSE
    RAISE EXCEPTION 'invalid: kind is incentive or loan.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('sacs.adjustment_decision', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_adjustment_decide(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_adjustment_decide(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.payroll_adjustment_insert_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payroll_adjustment_update_guard() FROM PUBLIC, anon, authenticated;
