-- Live bell channels restricted per user by RLS (decision 2026-11-09 #11).
--
-- Before (20261109040000): a public broadcast to "bell-<random topic>".
-- Now: a PRIVATE broadcast. Realtime lets a client join it only when an RLS
-- policy on realtime.messages allows that user: here, only the account whose
-- notification_channels row holds the topic (auth.uid() = user_id).
--
-- The browser gets a short-lived token for this from GET /api/notifications
-- (src/lib/realtime/bell-token.js, signed with the project's JWT secret;
-- role "authenticated"). That role has no grant on any public table and both
-- storage buckets refuse it (*_no_client_access), so the token reads nothing
-- but its own pings; e2e/specs/99-rls-channels.spec.mjs proves it.
--
-- The ping still carries no content. Additive. Safe to run more than once.

-- Who may listen on a bell topic: the topic's own account only.
CREATE OR REPLACE FUNCTION public.bell_topic_is_mine(p_topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.notification_channels c
    WHERE c.user_id = auth.uid() AND p_topic = 'bell-' || c.topic
  )
$$;
REVOKE ALL ON FUNCTION public.bell_topic_is_mine(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bell_topic_is_mine(text) TO authenticated;

DO $$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = 'bell_listen_own_topic') THEN
    CREATE POLICY bell_listen_own_topic ON realtime.messages
      FOR SELECT TO authenticated
      USING (realtime.messages.extension = 'broadcast' AND public.bell_topic_is_mine(realtime.topic()));
  END IF;
END $$;

-- The ping is sent as a private message from now on.
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
      PERFORM realtime.send('{}'::jsonb, 'ping', 'bell-' || v_topic, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block the notification itself.
    NULL;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notification_live_ping() FROM PUBLIC, anon, authenticated;
