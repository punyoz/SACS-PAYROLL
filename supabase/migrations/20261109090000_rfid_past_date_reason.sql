-- RFID card status dates (decision 2026-11-09 #7): a future date stays
-- refused (rfid_card_check_effective, 20261109010000); a PAST date is
-- allowed only with a reason. Today needs no extra reason beyond what each
-- action already asks for. Replaces the two dated overloads of
-- 20261109010000. Additive. Safe to run more than once.

CREATE OR REPLACE FUNCTION public.rfid_card_check_past_reason(p_effective date, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_effective IS NOT NULL
     AND p_effective < (now() AT TIME ZONE 'Asia/Manila')::date
     AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required: a change dated in the past needs a reason.'
      USING ERRCODE = 'check_violation';
  END IF;
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
  PERFORM public.rfid_card_check_past_reason(p_effective, p_reason);
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
  PERFORM public.rfid_card_check_past_reason(p_effective, p_reason);
  PERFORM set_config('sacs.rfid_effective_on', public.rfid_card_check_effective(p_effective)::text, true);
  v_row := public.rfid_card_set_status(p_actor, p_card, p_action, p_reason);
  PERFORM set_config('sacs.rfid_effective_on', '', true);
  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.rfid_card_check_past_reason(date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rfid_card_replace(uuid, uuid, text, text, boolean, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rfid_card_set_status(uuid, uuid, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfid_card_replace(uuid, uuid, text, text, boolean, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfid_card_set_status(uuid, uuid, text, text, date) TO service_role;
