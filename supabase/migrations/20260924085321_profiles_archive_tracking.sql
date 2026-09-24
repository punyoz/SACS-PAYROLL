-- ════════════════════════════════════════════════════════════════════════════
-- Account archiving: who archived an account, when, and profiles in step
--
-- WHY
-- Archive / Restore sits in the Edit dialog of HR's User Management (employee
-- and accountant records) and Super Admin's Admin & HR Accounts. The routes
-- behind them (/api/admin/employees and /api/admin/users, PATCH
-- { action: "archive" | "restore" }) flipped user_metadata.archived only.
-- Sign-in, the session check and the RFID scan read that flag, but
-- profiles.archived, which the branch reports and database-side readers use,
-- stayed false. The routes now write both. This migration adds the audit
-- columns they fill and brings existing rows into step.
--
-- COLUMNS
--   archived_at  when the account was last archived (NULL while active)
--   archived_by  the profile that archived it (NULL while active)
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS archived    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── Backfill: auth metadata is what sign-in has enforced so far ───────────

UPDATE public.profiles AS p
SET archived    = COALESCE(u.raw_user_meta_data->>'archived', 'false') = 'true',
    archived_at = CASE
      WHEN COALESCE(u.raw_user_meta_data->>'archived', 'false') = 'true' THEN COALESCE(p.archived_at, p.updated_at, now())
      ELSE NULL
    END,
    archived_by = CASE
      WHEN COALESCE(u.raw_user_meta_data->>'archived', 'false') = 'true' THEN p.archived_by
      ELSE NULL
    END
FROM auth.users AS u
WHERE u.id = p.id
  AND p.archived IS DISTINCT FROM (COALESCE(u.raw_user_meta_data->>'archived', 'false') = 'true');

-- ── An active account carries no archive stamp ──────────────────────────

CREATE OR REPLACE FUNCTION public.profiles_archive_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.archived THEN
    NEW.archived_at := COALESCE(NEW.archived_at, now());
  ELSE
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_archive_stamp ON public.profiles;
CREATE TRIGGER profiles_archive_stamp
  BEFORE INSERT OR UPDATE OF archived, archived_at, archived_by ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_archive_stamp();

-- Active-list reads filter on archived.
CREATE INDEX IF NOT EXISTS profiles_archived_idx ON public.profiles (archived);
