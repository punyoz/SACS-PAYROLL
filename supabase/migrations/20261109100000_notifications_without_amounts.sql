-- Notifications carry no amounts (decision 2026-11-09 #9): amounts show only
-- inside the app after sign-in. The app's own texts were reworded; this
-- trigger is the safety net for every writer, including the database
-- functions that wrote "net X -> Y" (payroll override notices). It removes
-- money amounts from the title and body before a notification is stored:
--   "(net 12,345.00 -> 13,000.00)" parts, "₱ 1,234.56", and plain
--   1,234.56-style decimals. Dates, counts and names are kept.
-- Rows already stored are not changed. Additive. Safe to run more than once.

CREATE OR REPLACE FUNCTION public.notification_text_without_amounts(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_text IS NULL THEN NULL ELSE
    btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      p_text,
      '\s*\(net [^)]*\)', '', 'gi'),
      '(PHP|₱)\s?-?[0-9][0-9,]*(\.[0-9]+)?', 'an amount', 'g'),
      '(^|[^0-9.,-])-?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]{2})?(?![0-9])', '\1an amount', 'g'),
      '(^|[^0-9.,:-])-?[0-9]+\.[0-9]{2}(?![0-9])', '\1an amount', 'g'),
      '\s{2,}', ' ', 'g'))
  END
$$;

CREATE OR REPLACE FUNCTION public.notifications_strip_amounts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.title := public.notification_text_without_amounts(NEW.title);
  NEW.body := public.notification_text_without_amounts(NEW.body);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notification_text_without_amounts(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notifications_strip_amounts() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notifications_strip_amounts' AND tgrelid = 'public.notifications'::regclass) THEN
    CREATE TRIGGER notifications_strip_amounts BEFORE INSERT ON public.notifications
      FOR EACH ROW EXECUTE FUNCTION public.notifications_strip_amounts();
  END IF;
END $$;
