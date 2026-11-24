-- ═══════════════════════════════════════════════════════════════════════════
-- Archived branch-Admin items (2026-11-26). Old endorsements, confirmations and
-- recommendations from before the Admins became view-only are kept, but hidden
-- from every screen once archived (with the reason). Additive; nothing deleted.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.branch_admin_requests ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE public.branch_admin_requests ADD COLUMN IF NOT EXISTS archived_reason TEXT;
CREATE INDEX IF NOT EXISTS branch_admin_requests_live_idx ON public.branch_admin_requests (kind, status) WHERE archived_at IS NULL;
