-- ═══════════════════════════════════════════════════════════════════════════
-- HR <-> branch Admin messages on an item (2026-11-24 release): a short thread
-- on anything the system sent to HR for a branch, or the Admin filed ("Can you
-- confirm ...?" / the Admin's answer). Information only, never a decision.
-- Written by the server (service role) only; never edited or deleted; every
-- message is also in the audit log (by the API).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.branch_item_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type    TEXT NOT NULL CHECK (item_type ~ '^[a-z_]{3,40}$'),
  item_id      TEXT NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 80),
  branch_id    UUID REFERENCES public.branches(id),
  author_id    UUID REFERENCES public.profiles(id),
  author_name  TEXT NOT NULL,
  author_role  TEXT NOT NULL CHECK (author_role IN ('hr', 'admin', 'super_admin')),
  body         TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS branch_item_messages_item_idx ON public.branch_item_messages (item_type, item_id, created_at);
CREATE INDEX IF NOT EXISTS branch_item_messages_branch_idx ON public.branch_item_messages (branch_id, created_at DESC);

ALTER TABLE public.branch_item_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.branch_item_messages FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.branch_item_messages_keep()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'A message is never edited or deleted.' USING ERRCODE = 'insufficient_privilege';
END;
$function$;
DROP TRIGGER IF EXISTS branch_item_messages_keep ON public.branch_item_messages;
CREATE TRIGGER branch_item_messages_keep BEFORE UPDATE OR DELETE ON public.branch_item_messages
  FOR EACH ROW EXECUTE FUNCTION public.branch_item_messages_keep();
