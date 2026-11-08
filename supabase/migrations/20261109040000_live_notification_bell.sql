-- Live notification bell (alpha test D2, 2026-11-09).
--
-- Before: the bell read GET /api/notifications every minute.
-- Now: every new row in public.notifications sends a Supabase Realtime
-- broadcast "ping" to its recipient's own channel, and the bell reloads at
-- once through GET /api/notifications (the signed session, the recipient's
-- own rows only).
--
-- What travels over Realtime: the event name "ping" and nothing else. No
-- title, body, amount, name or id. So roles and branches stay enforced by
-- the API, and no salary detail can leak through the socket.
--
-- The channel name: "bell-" + a random 128-bit topic per account
-- (public.notification_channels), handed to the signed-in user by
-- GET /api/notifications. Browsers have no access to the table (RLS on, no
-- grants), as with every other table (readiness audit 2026-10-12).
-- Broadcasts are public-channel messages, so someone who learned a topic
-- could see only that a ping happened, never what it was.
--
-- A Realtime failure never blocks the notification: the trigger swallows
-- errors (the bell still reloads every minute). Push notifications are not
-- built (decision 2026-11-09).
--
-- Additive. Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.notification_channels (
  user_id    UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  topic      TEXT NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(16), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_channels FROM anon, authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_channels' AND policyname = 'notification_channels_no_client_access') THEN
    CREATE POLICY notification_channels_no_client_access ON public.notification_channels
      FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
GRANT SELECT, INSERT ON public.notification_channels TO service_role;

CREATE OR REPLACE FUNCTION public.notification_live_ping()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_topic TEXT;
BEGIN
  BEGIN
    INSERT INTO public.notification_channels (user_id) VALUES (NEW.recipient_id)
    ON CONFLICT (user_id) DO NOTHING;
    SELECT topic INTO v_topic FROM public.notification_channels WHERE user_id = NEW.recipient_id;
    IF v_topic IS NOT NULL AND to_regprocedure('realtime.send(jsonb, text, text, boolean)') IS NOT NULL THEN
      PERFORM realtime.send('{}'::jsonb, 'ping', 'bell-' || v_topic, false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block the notification itself.
    NULL;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notification_live_ping() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notifications_live_ping' AND tgrelid = 'public.notifications'::regclass) THEN
    CREATE TRIGGER notifications_live_ping AFTER INSERT ON public.notifications
      FOR EACH ROW EXECUTE FUNCTION public.notification_live_ping();
  END IF;
END $$;
