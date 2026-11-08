-- RFID card status changes carry their date (alpha test A5, 2026-11-09).
--
-- Replace, Deactivate and Lost each record the day the change took effect
-- (default today, Manila; never a future day -- a Lost card cannot be lost
-- tomorrow, and a change dated ahead would need scheduling, which does not
-- exist), next to who did it and why, in the card history.
--
--   rfid_card_events.effective_on      the day the change took effect
--   rfid_card_replace(..., p_effective) / rfid_card_set_status(..., p_effective)
--                                      the existing functions with a date; they
--                                      pass it to the history row for this one
--                                      transaction and call the old ones, so the
--                                      rules (who, which card, reasons) stay in
--                                      one place.
--
-- Old history rows keep effective_on NULL (shown as the day they were
-- recorded). Nothing is changed or deleted. Safe to run more than once.

ALTER TABLE public.rfid_card_events ADD COLUMN IF NOT EXISTS effective_on DATE;
COMMENT ON COLUMN public.rfid_card_events.effective_on IS 'Day the change took effect (alpha test A5); NULL on rows recorded before 2026-11-09.';

CREATE OR REPLACE FUNCTION public.rfid_card_event(p_card rfid_cards, p_action text, p_from text, p_reason text, p_actor uuid, p_name text, p_role text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.rfid_card_events (card_id, employee_id, branch_id, action, from_status, to_status, uid_last4, reason, actor_id, actor_name, actor_role, effective_on)
  VALUES (p_card.id, p_card.employee_id, p_card.branch_id, p_action, p_from, p_card.status, p_card.uid_last4, p_reason, p_actor, p_name, p_role,
    COALESCE(NULLIF(current_setting('sacs.rfid_effective_on', true), '')::date, (now() AT TIME ZONE 'Asia/Manila')::date));
$function$;

CREATE OR REPLACE FUNCTION public.rfid_card_check_effective(p_effective date)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  IF p_effective IS NULL THEN RETURN v_today; END IF;
  IF p_effective > v_today THEN
    RAISE EXCEPTION 'invalid_date: the effective date cannot be in the future.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_effective < v_today - 366 THEN
    RAISE EXCEPTION 'invalid_date: the effective date is more than a year ago.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN p_effective;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rfid_card_replace(p_actor uuid, p_card uuid, p_new_uid text, p_reason text, p_lost boolean, p_effective date)
 RETURNS rfid_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row rfid_cards;
BEGIN
  PERFORM set_config('sacs.rfid_effective_on', public.rfid_card_check_effective(p_effective)::text, true);
  v_row := public.rfid_card_replace(p_actor, p_card, p_new_uid, p_reason, p_lost);
  PERFORM set_config('sacs.rfid_effective_on', '', true);
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rfid_card_set_status(p_actor uuid, p_card uuid, p_action text, p_reason text, p_effective date)
 RETURNS rfid_cards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row rfid_cards;
BEGIN
  PERFORM set_config('sacs.rfid_effective_on', public.rfid_card_check_effective(p_effective)::text, true);
  v_row := public.rfid_card_set_status(p_actor, p_card, p_action, p_reason);
  PERFORM set_config('sacs.rfid_effective_on', '', true);
  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.rfid_card_check_effective(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rfid_card_replace(uuid, uuid, text, text, boolean, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rfid_card_set_status(uuid, uuid, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfid_card_replace(uuid, uuid, text, text, boolean, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfid_card_set_status(uuid, uuid, text, text, date) TO service_role;
