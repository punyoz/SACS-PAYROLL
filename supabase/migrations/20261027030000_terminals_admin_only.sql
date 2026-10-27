-- Only the branch Admin adds RFID terminals (2026-10-27). HR stopped adding
-- them on 2026-10-26 (20261026010000); now the Super Admin does not either.
-- HR and the Super Admin still view, rename, move, switch and reset every
-- branch's terminals and open the RFID Terminal.
--
-- Both keep role_permissions "create" on rfid_devices: the same permission
-- registers RFID cards. So the refusal is here, on the insert branch of
-- rfid_terminal_save only (and in POST /api/rfid/terminals). Updates and the
-- Admin are exactly as in 20261026010000_hr_no_terminal_create.sql.
--
-- Additive: one function replaced with one wider check. No data changes;
-- terminals HR or the Super Admin already added stay as they are.

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
  -- A new terminal: the branch Admin's only, never HR's or the Super Admin's.
  IF p_terminal IS NULL AND v_actor.role IN ('hr', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden: only the branch Admin adds RFID terminals.' USING ERRCODE = 'insufficient_privilege';
  END IF;
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

REVOKE ALL ON FUNCTION public.rfid_terminal_save(UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfid_terminal_save(UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT) TO service_role;
