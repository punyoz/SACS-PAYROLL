-- The Super Admin posts announcements (2026-11-08).
--
-- 20261030010000 gave the Super Admin moderation only (read every
-- announcement, delete any) and left posting as the owner's open decision.
-- Decided 2026-11-08: the Super Admin posts like HR -- to the whole school
-- or any branch -- edits its OWN announcements, and keeps deleting any.
--
--   HR           posts, edits any, deletes any; whole school or any branch (unchanged)
--   Admin        its own branch, its own announcements (unchanged)
--   Super Admin  posts (whole school or any branch), edits its own (and may
--                change their audience), deletes any (moderation)
--   Accountant,
--   Employee     read only (unchanged)
--
-- Same functions, same limits (title 1-100, message 1-1000, types general /
-- holiday / meeting / schedule_change), same write-guard trigger.
-- author_role already allowed 'super_admin' (20261030010000).
-- Safe to run more than once.

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
  IF v_actor.id IS NULL OR v_actor.role NOT IN ('hr', 'admin', 'super_admin') THEN
    RAISE EXCEPTION 'forbidden: only HR, the branch Admin and the Super Admin post announcements.' USING ERRCODE = 'insufficient_privilege';
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

-- p_set_audience: HR (any announcement) or the Super Admin (its own) changes
-- who it is for (p_branch; NULL = whole school). An Admin's always stays with
-- its branch.
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
    OR (v_actor.role = 'super_admin' AND v_row.created_by = v_actor.id)
    OR (v_actor.role = 'admin' AND v_row.created_by = v_actor.id AND v_row.branch_id IS NOT DISTINCT FROM v_actor.branch_id AND v_actor.branch_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'forbidden: only its author (a branch Admin in their branch, or the Super Admin) or HR can change this announcement.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_branch := CASE WHEN v_actor.role IN ('hr', 'super_admin') AND p_set_audience THEN p_branch ELSE v_row.branch_id END;
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

REVOKE ALL ON FUNCTION public.announcement_post(uuid, uuid, text, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.announcement_edit(uuid, uuid, text, text, text, date, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.announcement_post(uuid, uuid, text, text, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.announcement_edit(uuid, uuid, text, text, text, date, boolean, uuid) TO service_role;

-- RLS for a signed-in client: the Super Admin may insert its own too.
DROP POLICY IF EXISTS branch_announcements_insert ON public.branch_announcements;
CREATE POLICY branch_announcements_insert ON public.branch_announcements FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid()) AND (
      private.current_role_name() IN ('hr', 'super_admin')
      OR (private.current_role_name() = 'admin' AND branch_id IS NOT NULL AND branch_id = private.current_branch_id())
    )
  );

-- The matrix (src/lib/rbac/permissions.js): Super Admin full on announcements, every branch.
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'announcements', 'all', true, true, true, true)
ON CONFLICT (role, module) DO UPDATE SET scope = EXCLUDED.scope, can_create = EXCLUDED.can_create,
  can_read = EXCLUDED.can_read, can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete, updated_at = now();
