-- Announcements for HR and branch Admins, with audience limits (2026-10-30).
--
-- Before: only the branch Admin posted (to its own branch); HR read every
-- branch's; the Super Admin had no access. Now:
--
--   HR           posts, edits and deletes for the whole school or any branch
--   Admin        posts, edits and deletes ITS OWN announcements, to ITS OWN
--                branch only (never school-wide, never another branch)
--   Super Admin  reads every announcement and deletes any (moderation only;
--                whether it posts routine announcements is the owner's decision)
--   Accountant,
--   Employee     read the school-wide ones and their own branch's
--
-- The app reaches this table with the service role (RLS bypassed), so the
-- rules are enforced in the only way in: announcement_post / _edit / _remove,
-- which check the acting user. Any other write is refused by a trigger. RLS
-- states the same rules for a signed-in client (who has no table grants).
--
--   branch_announcements.branch_id     NULL = the whole school
--   branch_announcements.author_role   who posted it (hr / admin)
--   branch_announcements.expires_on    optional: hidden from the normal view after this day
--   title 1-100 characters, body (the message) 1-1000 characters
--
-- "Delete" archives (archived, archived_at): hidden from everyone's normal
-- view, kept on file for the audit trail (block_hard_delete stays).
--
-- Safe to run more than once.

ALTER TABLE public.branch_announcements ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE public.branch_announcements ADD COLUMN IF NOT EXISTS author_role TEXT;
ALTER TABLE public.branch_announcements ADD COLUMN IF NOT EXISTS expires_on DATE;

-- Existing announcements were all posted by branch Admins.
DROP TRIGGER IF EXISTS branch_announcements_write_guard ON public.branch_announcements;
UPDATE public.branch_announcements a SET author_role = COALESCE(lower(p.role::TEXT), 'admin')
FROM public.profiles p WHERE p.id = a.created_by AND a.author_role IS NULL;
UPDATE public.branch_announcements SET author_role = 'admin' WHERE author_role IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_announcements_text_length') THEN
    ALTER TABLE public.branch_announcements DROP CONSTRAINT branch_announcements_text_length;
  END IF;
  ALTER TABLE public.branch_announcements ADD CONSTRAINT branch_announcements_text_length
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 100 AND char_length(btrim(body)) BETWEEN 1 AND 1000);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_announcements_author_role_check') THEN
    ALTER TABLE public.branch_announcements ADD CONSTRAINT branch_announcements_author_role_check
      CHECK (author_role IN ('hr', 'admin', 'super_admin'));
  END IF;
END $$;
ALTER TABLE public.branch_announcements ALTER COLUMN author_role SET NOT NULL;

CREATE INDEX IF NOT EXISTS branch_announcements_school_idx ON public.branch_announcements (created_at DESC) WHERE branch_id IS NULL;

-- ── The only way to write: functions that check the acting user ─────────────

CREATE OR REPLACE FUNCTION public.announcement_actor(p_actor uuid)
 RETURNS TABLE (id uuid, role text, branch_id uuid, full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.id, lower(COALESCE(p.role::TEXT, '')), p.branch_id, COALESCE(NULLIF(btrim(p.full_name), ''), p.email)
  FROM public.profiles p
  WHERE p.id = p_actor AND COALESCE(p.archived, FALSE) = FALSE;
$function$;

CREATE OR REPLACE FUNCTION public.announcement_check_text(p_title text, p_body text, p_category text, p_expires_on date)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  IF char_length(btrim(COALESCE(p_title, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_title: the title is required, at most 100 characters.' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(btrim(COALESCE(p_body, ''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_message: the message is required, at most 1,000 characters.' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(p_category, 'general') NOT IN ('general', 'holiday', 'meeting', 'schedule_change') THEN
    RAISE EXCEPTION 'invalid_category: unknown announcement type.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expires_on IS NOT NULL AND p_expires_on < (NOW() AT TIME ZONE 'Asia/Manila')::DATE THEN
    RAISE EXCEPTION 'invalid_expiry: the expiry date cannot be in the past.' USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.announcement_post(p_actor uuid, p_branch uuid, p_title text, p_body text, p_category text DEFAULT 'general', p_expires_on date DEFAULT NULL)
 RETURNS public.branch_announcements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor RECORD;
  v_row public.branch_announcements;
BEGIN
  SELECT * INTO v_actor FROM public.announcement_actor(p_actor);
  IF v_actor.id IS NULL OR v_actor.role NOT IN ('hr', 'admin') THEN
    RAISE EXCEPTION 'forbidden: only HR and the branch Admin post announcements.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor.role = 'admin' AND (v_actor.branch_id IS NULL OR p_branch IS DISTINCT FROM v_actor.branch_id) THEN
    RAISE EXCEPTION 'forbidden_audience: a branch Admin announces to its own branch only, never school-wide or to another branch.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch) THEN
    RAISE EXCEPTION 'invalid_audience: no such branch.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.announcement_check_text(p_title, p_body, p_category, p_expires_on);

  PERFORM set_config('sacs.announcement_action', 'on', true);
  INSERT INTO public.branch_announcements (branch_id, category, title, body, archived, author_role, expires_on,
    created_by, created_by_name, updated_by, updated_by_name)
  VALUES (p_branch, COALESCE(p_category, 'general'), btrim(p_title), btrim(p_body), FALSE, v_actor.role, p_expires_on,
    v_actor.id, v_actor.full_name, v_actor.id, v_actor.full_name)
  RETURNING * INTO v_row;
  PERFORM set_config('sacs.announcement_action', 'off', true);
  RETURN v_row;
END;
$function$;

-- p_set_audience: HR changes who it is for (p_branch; NULL = whole school).
-- An Admin's announcement always stays with its branch.
CREATE OR REPLACE FUNCTION public.announcement_edit(p_actor uuid, p_id uuid, p_title text, p_body text, p_category text, p_expires_on date, p_set_audience boolean DEFAULT FALSE, p_branch uuid DEFAULT NULL)
 RETURNS public.branch_announcements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor RECORD;
  v_row public.branch_announcements;
  v_branch UUID;
BEGIN
  SELECT * INTO v_actor FROM public.announcement_actor(p_actor);
  SELECT * INTO v_row FROM public.branch_announcements WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.archived THEN
    RAISE EXCEPTION 'not_found: no such announcement.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_actor.id IS NULL OR NOT (
    v_actor.role = 'hr'
    OR (v_actor.role = 'admin' AND v_row.created_by = v_actor.id AND v_row.branch_id IS NOT DISTINCT FROM v_actor.branch_id AND v_actor.branch_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'forbidden: only its author (a branch Admin, in their branch) or HR can change this announcement.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_branch := CASE WHEN v_actor.role = 'hr' AND p_set_audience THEN p_branch ELSE v_row.branch_id END;
  IF v_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch) THEN
    RAISE EXCEPTION 'invalid_audience: no such branch.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.announcement_check_text(p_title, p_body, p_category, p_expires_on);

  PERFORM set_config('sacs.announcement_action', 'on', true);
  UPDATE public.branch_announcements SET branch_id = v_branch, title = btrim(p_title), body = btrim(p_body),
    category = COALESCE(p_category, 'general'), expires_on = p_expires_on, updated_by = v_actor.id, updated_by_name = v_actor.full_name
  WHERE id = p_id RETURNING * INTO v_row;
  PERFORM set_config('sacs.announcement_action', 'off', true);
  RETURN v_row;
END;
$function$;

-- Delete = archive: hidden from everyone, kept on file.
CREATE OR REPLACE FUNCTION public.announcement_remove(p_actor uuid, p_id uuid)
 RETURNS public.branch_announcements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor RECORD;
  v_row public.branch_announcements;
BEGIN
  SELECT * INTO v_actor FROM public.announcement_actor(p_actor);
  SELECT * INTO v_row FROM public.branch_announcements WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.archived THEN
    RAISE EXCEPTION 'not_found: no such announcement.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_actor.id IS NULL OR NOT (
    v_actor.role IN ('hr', 'super_admin')
    OR (v_actor.role = 'admin' AND v_row.created_by = v_actor.id AND v_row.branch_id IS NOT DISTINCT FROM v_actor.branch_id AND v_actor.branch_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'forbidden: only its author (a branch Admin, in their branch), HR or the Super Admin can delete this announcement.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('sacs.announcement_action', 'on', true);
  UPDATE public.branch_announcements SET archived = TRUE, archived_at = NOW(), updated_by = v_actor.id, updated_by_name = v_actor.full_name
  WHERE id = p_id RETURNING * INTO v_row;
  PERFORM set_config('sacs.announcement_action', 'off', true);
  RETURN v_row;
END;
$function$;

-- Any other insert or update is refused, whoever sends it (the service role included).
CREATE OR REPLACE FUNCTION public.branch_announcements_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(current_setting('sacs.announcement_action', true), '') <> 'on' THEN
    RAISE EXCEPTION 'announcements_locked: post, edit or delete announcements through announcement_post / announcement_edit / announcement_remove.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER branch_announcements_write_guard BEFORE INSERT OR UPDATE ON public.branch_announcements
  FOR EACH ROW EXECUTE FUNCTION public.branch_announcements_write_guard();

REVOKE ALL ON FUNCTION public.announcement_actor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.announcement_post(uuid, uuid, text, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.announcement_edit(uuid, uuid, text, text, text, date, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.announcement_remove(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.announcement_post(uuid, uuid, text, text, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.announcement_edit(uuid, uuid, text, text, text, date, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.announcement_remove(uuid, uuid) TO service_role;

-- ── RLS: the same rules for a signed-in client ────────────────────────────

DROP POLICY IF EXISTS branch_announcements_read ON public.branch_announcements;
CREATE POLICY branch_announcements_read ON public.branch_announcements FOR SELECT TO authenticated
  USING (
    private.current_role_name() IN ('hr', 'super_admin')
    OR (private.current_role_name() IN ('admin', 'accountant', 'employee')
        AND (branch_id IS NULL OR branch_id = private.current_branch_id())
        AND (archived = FALSE OR (private.current_role_name() = 'admin' AND created_by = (SELECT auth.uid()))))
  );

DROP POLICY IF EXISTS branch_announcements_admin_write ON public.branch_announcements;
DROP POLICY IF EXISTS branch_announcements_insert ON public.branch_announcements;
CREATE POLICY branch_announcements_insert ON public.branch_announcements FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid()) AND (
      private.current_role_name() = 'hr'
      OR (private.current_role_name() = 'admin' AND branch_id IS NOT NULL AND branch_id = private.current_branch_id())
    )
  );

DROP POLICY IF EXISTS branch_announcements_admin_update ON public.branch_announcements;
DROP POLICY IF EXISTS branch_announcements_update ON public.branch_announcements;
CREATE POLICY branch_announcements_update ON public.branch_announcements FOR UPDATE TO authenticated
  USING (
    private.current_role_name() IN ('hr', 'super_admin')
    OR (private.current_role_name() = 'admin' AND created_by = (SELECT auth.uid()) AND branch_id IS NOT NULL AND branch_id = private.current_branch_id())
  )
  WITH CHECK (
    private.current_role_name() IN ('hr', 'super_admin')
    OR (private.current_role_name() = 'admin' AND created_by = (SELECT auth.uid()) AND branch_id IS NOT NULL AND branch_id = private.current_branch_id())
  );

-- ── Role permissions (mirrors src/lib/rbac/permissions.js) ─────────────────

INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('hr', 'announcements', 'all', true, true, true, true),
  ('super_admin', 'announcements', 'all', false, true, false, true)
ON CONFLICT (role, module) DO UPDATE SET scope = EXCLUDED.scope, can_create = EXCLUDED.can_create, can_read = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = NOW();
