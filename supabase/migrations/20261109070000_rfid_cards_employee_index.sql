-- RFID Cards list speed (alpha test B1, 2026-11-09).
--
-- GET /api/rfid/cards reads every card of the employees in reach:
--   rfid_cards WHERE employee_id IN (...) ORDER BY registered_at DESC, id
-- Only the partial unique index rfid_cards_one_active_per_employee (active
-- cards) started with employee_id, so replaced / lost / inactive cards meant
-- a full scan per chunk. Additive; no data is changed. Safe to run more than
-- once.

CREATE INDEX IF NOT EXISTS rfid_cards_employee_idx
  ON public.rfid_cards (employee_id, registered_at DESC, id);
