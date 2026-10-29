-- rfid_terminal_save is KEPT ON PURPOSE, as a guard that refuses every call.
--
-- RFID terminal management was removed on 2026-10-27
-- (20261027040000_rfid_terminals_removed.sql): nobody adds or changes
-- terminals, and the kiosk opens with the account's password instead. The
-- function was replaced with one that always raises insufficient_privilege,
-- rather than dropped, so that anything still calling it (an old deployment,
-- a cached client, a script) is refused loudly instead of failing with
-- "function does not exist" or, worse, a re-created writer slipping back in.
--
-- No code in the app calls it, so a cleanup pass will see it as unused. Do
-- not remove it, and do not change what it does. This migration only attaches
-- that note to the function itself (COMMENT ON), where schema tools show it;
-- the function's body, owner and grants are unchanged.

COMMENT ON FUNCTION public.rfid_terminal_save(UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT) IS
  'INTENTIONAL NO-OP GUARD - do not remove. Kept after RFID terminal management was removed (2026-10-27, 20261027040000_rfid_terminals_removed.sql) so every call is refused with insufficient_privilege. Nothing calls it on purpose; it is not dead code to clean up. Do not change its behaviour.';
