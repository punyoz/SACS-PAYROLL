-- ═══════════════════════════════════════════════════════════════════════════
-- RLS helper functions move out of the API-exposed schema
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The six SECURITY DEFINER helpers the row-level security policies call --
-- has_permission, can_reach_branch, current_branch_id, current_role_name,
-- get_user_role, is_super_admin -- lived in public, which PostgREST exposes,
-- so any signed-in user could call them directly at /rest/v1/rpc/<name>
-- (Supabase advisor 0029). They only reveal the caller's own role and branch,
-- but they are not meant to be an API.
--
-- EXECUTE cannot simply be revoked from authenticated: the policies run as
-- the querying role, so they would start failing. Moving the functions to a
-- schema PostgREST does not expose removes the endpoints while the policies
-- keep working -- a policy stores the function by its internal id, not by
-- name, so ALTER FUNCTION ... SET SCHEMA carries every policy along.
--
-- The helpers call one another by unqualified name, so their search_path now
-- lists private first.
--
-- Safe to run more than once.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('has_permission', 'can_reach_branch', 'current_branch_id',
                         'current_role_name', 'get_user_role', 'is_super_admin')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET SCHEMA private', fn.signature);
  END LOOP;

  FOR fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private'
       AND p.proname IN ('has_permission', 'can_reach_branch', 'current_branch_id',
                         'current_role_name', 'get_user_role', 'is_super_admin')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = private, public', fn.signature);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.signature);
  END LOOP;
END;
$$;

-- The helper bodies call each other schema-qualified (public.current_role_name()
-- and so on), which the move does not rewrite. Recreate each body with those
-- references pointing at private.
DO $$
DECLARE
  fn RECORD;
  def TEXT;
  helper TEXT;
BEGIN
  FOR fn IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private'
       AND p.proname IN ('has_permission', 'can_reach_branch', 'current_branch_id',
                         'current_role_name', 'get_user_role', 'is_super_admin')
  LOOP
    def := pg_get_functiondef(fn.oid);
    FOREACH helper IN ARRAY ARRAY['has_permission', 'can_reach_branch', 'current_branch_id',
                                  'current_role_name', 'get_user_role', 'is_super_admin']
    LOOP
      def := replace(def, 'public.' || helper || '(', 'private.' || helper || '(');
    END LOOP;
    EXECUTE def;
  END LOOP;
END;
$$;
