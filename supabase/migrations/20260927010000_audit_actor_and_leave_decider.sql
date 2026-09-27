-- ═══════════════════════════════════════════════════════════════════════════
-- Record WHO did it: audit log actor, leave decider
-- ═══════════════════════════════════════════════════════════════════════════
--
-- audit_logs recorded what happened but never who did it, so the trail could
-- not answer the one question an audit trail exists for. The API routes now
-- stamp every entry with the signed-in caller taken from the signed session
-- (src/lib/audit/store.js), never from the request body.
--
-- leave_requests recorded that a request was approved or rejected, and when,
-- but not by whom. Leave decides paid versus unpaid days, so the decider is
-- stored with the decision (src/app/api/hr/leave-requests/route.js).
--
-- No foreign keys on the actor columns: an entry must still be written for a
-- caller whose profile row is missing, and profiles are never deleted anyway
-- (block_hard_delete).
--
-- Safe to run more than once.

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS actor_id   UUID,
  ADD COLUMN IF NOT EXISTS actor_role TEXT,
  ADD COLUMN IF NOT EXISTS actor_name TEXT,
  ADD COLUMN IF NOT EXISTS actor_ip   TEXT;

CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx
  ON public.audit_logs (actor_id, created_at DESC);

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS decided_by      UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS decided_by_name TEXT;

CREATE INDEX IF NOT EXISTS leave_requests_decided_by_idx
  ON public.leave_requests (decided_by);
