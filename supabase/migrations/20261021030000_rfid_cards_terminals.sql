-- RFID cards and terminals (2026-10-21).
--
-- Before this, a card was only profiles.rfid_uid: no statuses, no history of
-- who registered, replaced or voided it, and no record of which reader a tap
-- came from. HR also had no access; only the Admin (own branch) and the
-- Super Admin did.
--
-- Now:
--   rfid_cards           one row per physical card: Active, Inactive, Lost or
--                        Replaced, with who registered it (name and role) and when
--   rfid_card_events     every card action, append-only: registered, replaced,
--                        deactivated, reactivated, marked lost, imported
--   rfid_terminals       the readers: name, branch, Active / Inactive, last tap,
--                        and a key version (resetting it locks out every kiosk
--                        opened with the old key)
--   attendance_taps.terminal_id   the terminal each tap came from
--
-- profiles.rfid_uid stays the one copy the tap path matches against, and is
-- now only the employee's ACTIVE card: an inactive, lost or replaced card is
-- cleared from it, so it can never record attendance.
--
-- Who may do what is checked here, not only in the app (the app reaches these
-- tables with the server key, so per-user RLS would never apply; RLS shuts
-- out every direct browser access instead):
--   HR, Super Admin   every branch
--   Admin             employees and terminals of its own branch only
--   Accountant, Employee   nothing
-- Every write to the cards, their history, the terminals and
-- profiles.rfid_uid goes through the functions below; anything else is refused.
--
-- Data: the cards already in profiles.rfid_uid are imported as card rows
-- (rows are added; nothing existing is changed or removed).

-- ── 1. Tables ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rfid_cards (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            UUID NOT NULL REFERENCES public.profiles(id),
  branch_id              UUID REFERENCES public.branches(id),
  uid                    TEXT NOT NULL CHECK (uid ~ '^[0-9]{1,16}$'),
  uid_last4              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'lost', 'replaced')),
  registered_by          UUID REFERENCES public.profiles(id),
  registered_by_name     TEXT NOT NULL,
  registered_by_role     TEXT NOT NULL,
  registered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replaces_card_id       UUID REFERENCES public.rfid_cards(id),
  status_reason          TEXT,
  status_changed_by      UUID REFERENCES public.profiles(id),
  status_changed_by_name TEXT,
  status_changed_by_role TEXT,
  status_changed_at      TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One active card per UID, and one active card per employee.
CREATE UNIQUE INDEX IF NOT EXISTS rfid_cards_one_active_uid ON public.rfid_cards (uid) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS rfid_cards_one_active_per_employee ON public.rfid_cards (employee_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS rfid_cards_uid_idx ON public.rfid_cards (uid);
CREATE INDEX IF NOT EXISTS rfid_cards_branch_idx ON public.rfid_cards (branch_id, status);
CREATE INDEX IF NOT EXISTS rfid_cards_registered_by_idx ON public.rfid_cards (registered_by);
CREATE INDEX IF NOT EXISTS rfid_cards_status_changed_by_idx ON public.rfid_cards (status_changed_by);
CREATE INDEX IF NOT EXISTS rfid_cards_replaces_idx ON public.rfid_cards (replaces_card_id);

CREATE TABLE IF NOT EXISTS public.rfid_card_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      UUID NOT NULL REFERENCES public.rfid_cards(id),
  employee_id  UUID NOT NULL REFERENCES public.profiles(id),
  branch_id    UUID REFERENCES public.branches(id),
  action       TEXT NOT NULL CHECK (action IN ('registered', 'replaced', 'deactivated', 'reactivated', 'marked_lost', 'imported')),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  uid_last4    TEXT NOT NULL,
  reason       TEXT,
  actor_id     UUID REFERENCES public.profiles(id),
  actor_name   TEXT NOT NULL,
  actor_role   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rfid_card_events_card_idx ON public.rfid_card_events (card_id, created_at);
CREATE INDEX IF NOT EXISTS rfid_card_events_employee_idx ON public.rfid_card_events (employee_id);
CREATE INDEX IF NOT EXISTS rfid_card_events_branch_idx ON public.rfid_card_events (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rfid_card_events_actor_idx ON public.rfid_card_events (actor_id);

CREATE TABLE IF NOT EXISTS public.rfid_terminals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  branch_id              UUID REFERENCES public.branches(id),   -- NULL: every branch (HR / Super Admin only)
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  key_version            INTEGER NOT NULL DEFAULT 1,
  last_tap_at            TIMESTAMPTZ,
  last_tap_result        TEXT,
  status_reason          TEXT,
  created_by             UUID REFERENCES public.profiles(id),
  created_by_name        TEXT NOT NULL,
  created_by_role        TEXT NOT NULL,
  updated_by_name        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS rfid_terminals_unique_name
  ON public.rfid_terminals (COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::UUID), lower(btrim(name)));
CREATE INDEX IF NOT EXISTS rfid_terminals_branch_idx ON public.rfid_terminals (branch_id);
CREATE INDEX IF NOT EXISTS rfid_terminals_created_by_idx ON public.rfid_terminals (created_by);

ALTER TABLE public.attendance_taps ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES public.rfid_terminals(id);
CREATE INDEX IF NOT EXISTS attendance_taps_terminal_idx ON public.attendance_taps (terminal_id);

-- RLS: no direct browser access at all (the app uses the functions below).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['rfid_cards', 'rfid_card_events', 'rfid_terminals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_no_client_access', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t || '_no_client_access', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_block_hard_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete()', t || '_block_hard_delete', t);
  END LOOP;
END $$;

-- The permission matrix (src/lib/rbac/permissions.js): HR gains RFID devices
-- for every branch; the Admin can now also register (create) for its branch.
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('hr',    'rfid_devices', 'all',    true, true, true, false),
  ('admin', 'rfid_devices', 'branch', true, true, true, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = NOW();

-- ── 2. Only the functions write ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rfid_flow_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('sacs.rfid_flow', true), '') <> 'on' THEN
    RAISE EXCEPTION 'RFID cards and terminals change only through RFID registration (HR, Super Admin, or the Admin of the branch).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'rfid_card_events' THEN
    RAISE EXCEPTION 'The RFID card history is never changed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('rfid_cards', 'rfid_terminals') THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS rfid_cards_flow_guard ON public.rfid_cards;
CREATE TRIGGER rfid_cards_flow_guard BEFORE INSERT OR UPDATE ON public.rfid_cards FOR EACH ROW EXECUTE FUNCTION public.rfid_flow_guard();
DROP TRIGGER IF EXISTS rfid_card_events_flow_guard ON public.rfid_card_events;
CREATE TRIGGER rfid_card_events_flow_guard BEFORE INSERT OR UPDATE ON public.rfid_card_events FOR EACH ROW EXECUTE FUNCTION public.rfid_flow_guard();
DROP TRIGGER IF EXISTS rfid_terminals_flow_guard ON public.rfid_terminals;
CREATE TRIGGER rfid_terminals_flow_guard BEFORE INSERT OR UPDATE ON public.rfid_terminals FOR EACH ROW EXECUTE FUNCTION public.rfid_flow_guard();

-- profiles.rfid_uid (what a tap matches) follows the active card only.
CREATE OR REPLACE FUNCTION public.profiles_rfid_uid_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('sacs.rfid_flow', true), '') = 'on' THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT' AND NEW.rfid_uid IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.rfid_uid IS DISTINCT FROM OLD.rfid_uid) THEN
    RAISE EXCEPTION 'An RFID card is registered, replaced or deactivated only through RFID registration.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS profiles_rfid_uid_guard ON public.profiles;
CREATE TRIGGER profiles_rfid_uid_guard BEFORE INSERT OR UPDATE OF rfid_uid ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_rfid_uid_guard();

-- ── 3. Import the cards already registered ─────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('sacs.rfid_flow', 'on', true);
  INSERT INTO public.rfid_cards (employee_id, branch_id, uid, uid_last4, status, registered_by_name, registered_by_role,
    registered_at, status_reason)
  SELECT p.id, p.branch_id, btrim(p.rfid_uid), right(btrim(p.rfid_uid), 4),
         CASE WHEN COALESCE(p.archived, FALSE) THEN 'inactive' ELSE 'active' END,
         'Imported (registered before card records)', 'system', COALESCE(p.updated_at, NOW()),
         CASE WHEN COALESCE(p.archived, FALSE) THEN 'Employee archived' END
  FROM public.profiles p
  WHERE p.rfid_uid IS NOT NULL AND btrim(p.rfid_uid) ~ '^[0-9]{1,16}$'
    AND NOT EXISTS (SELECT 1 FROM public.rfid_cards c WHERE c.employee_id = p.id AND c.uid = btrim(p.rfid_uid));
  INSERT INTO public.rfid_card_events (card_id, employee_id, branch_id, action, from_status, to_status, uid_last4, reason, actor_name, actor_role, created_at)
  SELECT c.id, c.employee_id, c.branch_id, 'imported', NULL, c.status, c.uid_last4, 'Card registered before card records existed',
         'System', 'system', NOW()
  FROM public.rfid_cards c
  WHERE NOT EXISTS (SELECT 1 FROM public.rfid_card_events e WHERE e.card_id = c.id);
  PERFORM set_config('sacs.rfid_flow', '', true);
END $$;

-- ── 4. The steps ───────────────────────────────────────────────────────────

-- Who may act for this branch (NULL = any branch). Raises when not allowed.
CREATE OR REPLACE FUNCTION public.rfid_actor_for(p_actor UUID, p_branch UUID, p_what TEXT)
RETURNS TABLE (id UUID, role TEXT, branch_id UUID, full_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM public.payroll_run_actor(p_actor);
  IF v.id IS NULL OR v.role NOT IN ('hr', 'super_admin', 'admin') THEN
    RAISE EXCEPTION 'forbidden: only HR, the Super Admin or a branch Admin manages %.', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v.role = 'admin' AND (v.branch_id IS NULL OR p_branch IS NULL OR p_branch IS DISTINCT FROM v.branch_id) THEN
    RAISE EXCEPTION 'forbidden: an Admin manages % of its own branch only.', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT v.id, v.role, v.branch_id, v.full_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.rfid_card_event(p_card public.rfid_cards, p_action TEXT, p_from TEXT, p_reason TEXT,
  p_actor UUID, p_name TEXT, p_role TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.rfid_card_events (card_id, employee_id, branch_id, action, from_status, to_status, uid_last4, reason, actor_id, actor_name, actor_role)
  VALUES (p_card.id, p_card.employee_id, p_card.branch_id, p_action, p_from, p_card.status, p_card.uid_last4, p_reason, p_actor, p_name, p_role);
$$;

-- The card a UID may become: refuses one in use, or reported lost / replaced.
CREATE OR REPLACE FUNCTION public.rfid_uid_free(p_uid TEXT, p_employee UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid TEXT := btrim(COALESCE(p_uid, ''));
  v_owner TEXT;
BEGIN
  IF v_uid !~ '^[0-9]{1,16}$' THEN
    RAISE EXCEPTION 'invalid: the RFID UID must be the card''s number: digits only, up to 16.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(NULLIF(p.full_name, ''), p.email) INTO v_owner
  FROM public.rfid_cards c JOIN public.profiles p ON p.id = c.employee_id
  WHERE c.uid = v_uid AND c.status = 'active' LIMIT 1;
  IF v_owner IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate: this card is already assigned to %.', v_owner USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rfid_cards c WHERE c.uid = v_uid AND c.status IN ('lost', 'replaced')) THEN
    RAISE EXCEPTION 'blocked: this card was reported lost or replaced and can never be used again.' USING ERRCODE = 'check_violation';
  END IF;
  -- An archived employee's old card number is released for reuse.
  UPDATE public.profiles SET rfid_uid = NULL WHERE rfid_uid = v_uid AND id <> p_employee AND COALESCE(archived, FALSE);
  IF EXISTS (SELECT 1 FROM public.profiles WHERE rfid_uid = v_uid AND id <> p_employee) THEN
    RAISE EXCEPTION 'duplicate: this card is already assigned to another employee.' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.rfid_card_register(p_actor UUID, p_employee UUID, p_uid TEXT, p_reason TEXT)
RETURNS public.rfid_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor RECORD;
  v_person public.profiles;
  v_uid TEXT;
  v_card public.rfid_cards;
  v_active public.rfid_cards;
BEGIN
  SELECT * INTO v_person FROM public.profiles WHERE id = p_employee;
  IF v_person.id IS NULL OR v_person.role::TEXT NOT IN ('employee', 'accountant') OR COALESCE(v_person.archived, FALSE) THEN
    RAISE EXCEPTION 'invalid: RFID cards are registered to active Employee and Accountant accounts only.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, v_person.branch_id, 'RFID cards');
  SELECT * INTO v_active FROM public.rfid_cards WHERE employee_id = v_person.id AND status = 'active';
  IF v_active.id IS NOT NULL THEN
    RAISE EXCEPTION 'already_active: % already has an active card (ending %). Replace it instead.', v_person.full_name, v_active.uid_last4
      USING ERRCODE = 'unique_violation';
  END IF;

  PERFORM set_config('sacs.rfid_flow', 'on', true);
  v_uid := public.rfid_uid_free(p_uid, v_person.id);
  INSERT INTO public.rfid_cards (employee_id, branch_id, uid, uid_last4, status, registered_by, registered_by_name, registered_by_role, status_reason)
  VALUES (v_person.id, v_person.branch_id, v_uid, right(v_uid, 4), 'active', v_actor.id, v_actor.full_name, v_actor.role,
          NULLIF(btrim(COALESCE(p_reason, '')), ''))
  RETURNING * INTO v_card;
  UPDATE public.profiles SET rfid_uid = v_uid WHERE id = v_person.id;
  PERFORM public.rfid_card_event(v_card, 'registered', NULL, NULLIF(btrim(COALESCE(p_reason, '')), ''), v_actor.id, v_actor.full_name, v_actor.role);
  PERFORM set_config('sacs.rfid_flow', '', true);
  RETURN v_card;
END;
$$;

-- Replace a lost or damaged card: the old one is Lost / Replaced (never taps
-- again), the new one becomes the active card. A reason is required.
CREATE OR REPLACE FUNCTION public.rfid_card_replace(p_actor UUID, p_card UUID, p_new_uid TEXT, p_reason TEXT, p_lost BOOLEAN)
RETURNS public.rfid_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor RECORD;
  v_old public.rfid_cards;
  v_new public.rfid_cards;
  v_person public.profiles;
  v_uid TEXT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  SELECT * INTO v_old FROM public.rfid_cards WHERE id = p_card FOR UPDATE;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'not_found: no such RFID card.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_person FROM public.profiles WHERE id = v_old.employee_id;
  SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, v_person.branch_id, 'RFID cards');
  IF v_old.status <> 'active' THEN
    RAISE EXCEPTION 'invalid_transition: only an active card is replaced (this one is %).', v_old.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RAISE EXCEPTION 'reason_required: give the reason for replacing the card (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(COALESCE(p_new_uid, '')) = v_old.uid THEN
    RAISE EXCEPTION 'invalid: the new card must have a different number.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.rfid_flow', 'on', true);
  UPDATE public.rfid_cards
  SET status = CASE WHEN p_lost THEN 'lost' ELSE 'replaced' END, status_reason = v_reason,
      status_changed_by = v_actor.id, status_changed_by_name = v_actor.full_name, status_changed_by_role = v_actor.role, status_changed_at = NOW()
  WHERE id = v_old.id RETURNING * INTO v_old;
  UPDATE public.profiles SET rfid_uid = NULL WHERE id = v_person.id;
  v_uid := public.rfid_uid_free(p_new_uid, v_person.id);
  INSERT INTO public.rfid_cards (employee_id, branch_id, uid, uid_last4, status, registered_by, registered_by_name, registered_by_role,
    replaces_card_id, status_reason)
  VALUES (v_person.id, v_person.branch_id, v_uid, right(v_uid, 4), 'active', v_actor.id, v_actor.full_name, v_actor.role, v_old.id, v_reason)
  RETURNING * INTO v_new;
  UPDATE public.profiles SET rfid_uid = v_uid WHERE id = v_person.id;
  PERFORM public.rfid_card_event(v_old, 'replaced', 'active', v_reason, v_actor.id, v_actor.full_name, v_actor.role);
  PERFORM public.rfid_card_event(v_new, 'registered', NULL, format('Replaces the card ending %s: %s', v_old.uid_last4, v_reason),
    v_actor.id, v_actor.full_name, v_actor.role);
  PERFORM set_config('sacs.rfid_flow', '', true);
  RETURN v_new;
END;
$$;

-- Deactivate (resigned, transferred), mark lost, or reactivate. A reason is required.
CREATE OR REPLACE FUNCTION public.rfid_card_set_status(p_actor UUID, p_card UUID, p_action TEXT, p_reason TEXT)
RETURNS public.rfid_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor RECORD;
  v_card public.rfid_cards;
  v_person public.profiles;
  v_from TEXT;
  v_to TEXT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  SELECT * INTO v_card FROM public.rfid_cards WHERE id = p_card FOR UPDATE;
  IF v_card.id IS NULL THEN RAISE EXCEPTION 'not_found: no such RFID card.' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_person FROM public.profiles WHERE id = v_card.employee_id;
  SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, v_person.branch_id, 'RFID cards');
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RAISE EXCEPTION 'reason_required: give the reason (at least 5 characters).' USING ERRCODE = 'check_violation';
  END IF;
  v_from := v_card.status;
  v_to := CASE p_action WHEN 'deactivate' THEN 'inactive' WHEN 'mark_lost' THEN 'lost' WHEN 'reactivate' THEN 'active' END;
  IF v_to IS NULL THEN RAISE EXCEPTION 'invalid: deactivate, mark_lost or reactivate.' USING ERRCODE = 'check_violation'; END IF;
  IF (p_action = 'deactivate' AND v_from <> 'active')
     OR (p_action = 'mark_lost' AND v_from NOT IN ('active', 'inactive'))
     OR (p_action = 'reactivate' AND v_from <> 'inactive') THEN
    RAISE EXCEPTION 'invalid_transition: a % card cannot be %.', v_from,
      CASE p_action WHEN 'deactivate' THEN 'deactivated' WHEN 'mark_lost' THEN 'marked lost' ELSE 'reactivated' END
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('sacs.rfid_flow', 'on', true);
  IF p_action = 'reactivate' THEN
    IF COALESCE(v_person.archived, FALSE) OR v_person.role::TEXT NOT IN ('employee', 'accountant') THEN
      RAISE EXCEPTION 'invalid: the employee is archived; register a card again once the account is active.' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.rfid_cards WHERE employee_id = v_person.id AND status = 'active') THEN
      RAISE EXCEPTION 'already_active: % already has an active card. Deactivate it first.', v_person.full_name USING ERRCODE = 'unique_violation';
    END IF;
    PERFORM public.rfid_uid_free(v_card.uid, v_person.id);
  END IF;
  UPDATE public.rfid_cards
  SET status = v_to, status_reason = v_reason, status_changed_by = v_actor.id, status_changed_by_name = v_actor.full_name,
      status_changed_by_role = v_actor.role, status_changed_at = NOW(),
      branch_id = CASE WHEN p_action = 'reactivate' THEN v_person.branch_id ELSE branch_id END
  WHERE id = v_card.id RETURNING * INTO v_card;
  UPDATE public.profiles SET rfid_uid = CASE WHEN v_to = 'active' THEN v_card.uid ELSE NULL END
  WHERE id = v_person.id AND (v_to = 'active' OR rfid_uid = v_card.uid);
  PERFORM public.rfid_card_event(v_card, CASE p_action WHEN 'deactivate' THEN 'deactivated' WHEN 'mark_lost' THEN 'marked_lost' ELSE 'reactivated' END,
    v_from, v_reason, v_actor.id, v_actor.full_name, v_actor.role);
  PERFORM set_config('sacs.rfid_flow', '', true);
  RETURN v_card;
END;
$$;

-- Register / rename / switch a terminal on or off, or reset its key (every
-- kiosk opened with the old key must be unlocked again).
CREATE OR REPLACE FUNCTION public.rfid_terminal_save(p_actor UUID, p_terminal UUID, p_name TEXT, p_branch UUID, p_status TEXT,
  p_reset_key BOOLEAN, p_reason TEXT)
RETURNS public.rfid_terminals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor RECORD;
  v_term public.rfid_terminals;
  v_name TEXT := btrim(COALESCE(p_name, ''));
BEGIN
  IF p_terminal IS NOT NULL THEN
    SELECT * INTO v_term FROM public.rfid_terminals WHERE id = p_terminal FOR UPDATE;
    IF v_term.id IS NULL THEN RAISE EXCEPTION 'not_found: no such terminal.' USING ERRCODE = 'no_data_found'; END IF;
    SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, v_term.branch_id, 'RFID terminals');
  END IF;
  -- The branch it serves (also checked for a move).
  SELECT * INTO v_actor FROM public.rfid_actor_for(p_actor, p_branch, 'RFID terminals');
  IF length(v_name) NOT BETWEEN 2 AND 60 THEN
    RAISE EXCEPTION 'invalid: name the terminal (2 to 60 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(p_status, 'active') NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'invalid: a terminal is active or inactive.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rfid_terminals t WHERE COALESCE(t.branch_id, '00000000-0000-0000-0000-000000000000'::UUID)
             = COALESCE(p_branch, '00000000-0000-0000-0000-000000000000'::UUID) AND lower(btrim(t.name)) = lower(v_name)
             AND t.id IS DISTINCT FROM p_terminal) THEN
    RAISE EXCEPTION 'duplicate: a terminal named "%" already exists there.', v_name USING ERRCODE = 'unique_violation';
  END IF;

  PERFORM set_config('sacs.rfid_flow', 'on', true);
  IF v_term.id IS NULL THEN
    INSERT INTO public.rfid_terminals (name, branch_id, status, created_by, created_by_name, created_by_role)
    VALUES (v_name, p_branch, COALESCE(p_status, 'active'), v_actor.id, v_actor.full_name, v_actor.role)
    RETURNING * INTO v_term;
  ELSE
    UPDATE public.rfid_terminals
    SET name = v_name, branch_id = p_branch, status = COALESCE(p_status, status),
        key_version = key_version + CASE WHEN p_reset_key OR (COALESCE(p_status, status) = 'inactive' AND status = 'active') THEN 1 ELSE 0 END,
        status_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''), updated_by_name = v_actor.full_name
    WHERE id = v_term.id RETURNING * INTO v_term;
  END IF;
  PERFORM set_config('sacs.rfid_flow', '', true);
  RETURN v_term;
END;
$$;

-- A tap reached this terminal (accepted or not): its last-seen time.
CREATE OR REPLACE FUNCTION public.rfid_terminal_touch(p_terminal UUID, p_result TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('sacs.rfid_flow', 'on', true);
  UPDATE public.rfid_terminals SET last_tap_at = NOW(), last_tap_result = left(COALESCE(p_result, ''), 40) WHERE id = p_terminal;
  PERFORM set_config('sacs.rfid_flow', '', true);
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.rfid_flow_guard()', 'public.profiles_rfid_uid_guard()', 'public.rfid_actor_for(uuid, uuid, text)',
    'public.rfid_card_event(public.rfid_cards, text, text, text, uuid, text, text)', 'public.rfid_uid_free(text, uuid)',
    'public.rfid_card_register(uuid, uuid, text, text)', 'public.rfid_card_replace(uuid, uuid, text, text, boolean)',
    'public.rfid_card_set_status(uuid, uuid, text, text)',
    'public.rfid_terminal_save(uuid, uuid, text, uuid, text, boolean, text)', 'public.rfid_terminal_touch(uuid, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.rfid_card_register(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfid_card_replace(UUID, UUID, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfid_card_set_status(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfid_terminal_save(UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfid_terminal_touch(UUID, TEXT) TO service_role;
