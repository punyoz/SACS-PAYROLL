-- Registered RFID terminals are removed (2026-10-27): nobody adds or changes
-- them, not the branch Admin, HR or the Super Admin. The kiosk
-- (/rfid-terminal) opens with the account's password and no terminal to
-- choose; a branch Admin's kiosk takes its own branch's cards only, HR's and
-- the Super Admin's every branch's. /api/rfid/terminals and the RFID
-- terminals screens are gone from the app.
--
-- rfid_terminal_save (the only writer of public.rfid_terminals) now refuses
-- every call. No data is dropped: the table and its rows stay, unused, and
-- attendance_taps.terminal_id keeps the terminal of taps already recorded.
-- rfid_terminal_touch (a tap's "last tap" stamp) is no longer called.

CREATE OR REPLACE FUNCTION public.rfid_terminal_save(p_actor UUID, p_terminal UUID, p_name TEXT, p_branch UUID, p_status TEXT,
  p_reset_key BOOLEAN, p_reason TEXT)
RETURNS public.rfid_terminals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'forbidden: RFID terminals are no longer added or changed; the kiosk opens with your password.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION public.rfid_terminal_save(UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfid_terminal_save(UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT) TO service_role;
