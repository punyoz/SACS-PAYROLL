-- ════════════════════════════════════════════════════════════════════════════
-- Admin branch oversight (2026-10-20, the user's instruction)
--
-- The Admin is the branch head's oversight role: it recommends, HR decides,
-- the Accountant processes, the Super Admin maintains the system. Everything
-- it sees or does is its own branch's.
--
--   branch_admin_requests  one row per thing the Admin sends HR, by kind:
--     attendance_flag        a record HR should look at          Pending → Resolved
--     leave_endorsement      Endorsed / Not endorsed (HR decides the leave)
--     incident_report        e.g. a no-show; opens an AWOL case  Pending → Resolved
--     schedule_request       schedule / class-load change        Pending → Approved / Rejected
--     transfer_endorsement   Endorsed / Not endorsed (HR decides the transfer)
--     rfid_issue             lost / broken card or reader        Pending → Resolved (HR or Super Admin)
--     overtime_confirmation  overtime / substitute teaching happened: Endorsed / Not endorsed
--                            (the Accountant reads it before paying)
--     incentive_endorsement  recommended incentive / overload    Pending → Approved / Rejected
--   Every change is appended to `history` (who, role, when, status, remark);
--   rows are never deleted.
--
--   branch_announcements   posted by the branch Admin for its employees.
--
-- Every table carries branch_id. The app reaches them through its server
-- routes (service role), which scope every query to the caller's branch;
-- the RLS policies below are the same rule for any signed-in client, and,
-- as for every table since 20261012020000, anon / authenticated hold no
-- table grant at all.
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.branch_admin_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL REFERENCES public.branches(id),
  kind            TEXT NOT NULL CHECK (kind IN ('attendance_flag', 'leave_endorsement', 'incident_report', 'schedule_request',
                    'transfer_endorsement', 'rfid_issue', 'overtime_confirmation', 'incentive_endorsement')),
  employee_id     UUID REFERENCES public.profiles(id),
  ref_id          TEXT,                    -- attendance log / leave request / transfer request id
  details         JSONB NOT NULL DEFAULT '{}'::JSONB,
  admin_note      TEXT NOT NULL CHECK (length(trim(admin_note)) > 0),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'endorsed', 'not_endorsed', 'approved', 'rejected', 'resolved')),
  created_by      UUID REFERENCES public.profiles(id),
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by      UUID REFERENCES public.profiles(id),
  decided_by_name TEXT,
  decided_by_role TEXT CHECK (decided_by_role IS NULL OR decided_by_role IN ('hr', 'super_admin')),
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  outcome_ref     TEXT,                    -- the AWOL case / incentive item a decision produced
  history         JSONB NOT NULL DEFAULT '[]'::JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT branch_admin_requests_decided_chk CHECK (
    status IN ('pending', 'endorsed', 'not_endorsed') OR (decided_at IS NOT NULL AND decided_by_role IS NOT NULL))
);

-- One endorsement / confirmation per branch per record (it can be changed, with history).
CREATE UNIQUE INDEX IF NOT EXISTS branch_admin_requests_one_endorsement
  ON public.branch_admin_requests (kind, ref_id, branch_id)
  WHERE ref_id IS NOT NULL AND kind IN ('leave_endorsement', 'transfer_endorsement', 'overtime_confirmation');
CREATE INDEX IF NOT EXISTS branch_admin_requests_branch_idx ON public.branch_admin_requests (branch_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS branch_admin_requests_kind_status_idx ON public.branch_admin_requests (kind, status);
CREATE INDEX IF NOT EXISTS branch_admin_requests_employee_idx ON public.branch_admin_requests (employee_id);
CREATE INDEX IF NOT EXISTS branch_admin_requests_created_by_idx ON public.branch_admin_requests (created_by);
CREATE INDEX IF NOT EXISTS branch_admin_requests_decided_by_idx ON public.branch_admin_requests (decided_by);

CREATE TABLE IF NOT EXISTS public.branch_announcements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL REFERENCES public.branches(id),
  category        TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'holiday', 'meeting', 'schedule_change')),
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body            TEXT NOT NULL CHECK (length(trim(body)) > 0),
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID REFERENCES public.profiles(id),
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES public.profiles(id),
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS branch_announcements_branch_idx ON public.branch_announcements (branch_id, archived, created_at DESC);
CREATE INDEX IF NOT EXISTS branch_announcements_created_by_idx ON public.branch_announcements (created_by);
CREATE INDEX IF NOT EXISTS branch_announcements_updated_by_idx ON public.branch_announcements (updated_by);

-- Never physically removed: decided, resolved and removed records stay on file.
DROP TRIGGER IF EXISTS branch_admin_requests_block_hard_delete ON public.branch_admin_requests;
CREATE TRIGGER branch_admin_requests_block_hard_delete BEFORE DELETE ON public.branch_admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();
DROP TRIGGER IF EXISTS branch_announcements_block_hard_delete ON public.branch_announcements;
CREATE TRIGGER branch_announcements_block_hard_delete BEFORE DELETE ON public.branch_announcements
  FOR EACH ROW EXECUTE FUNCTION public.block_hard_delete();
DROP TRIGGER IF EXISTS branch_admin_requests_set_updated_at ON public.branch_admin_requests;
CREATE TRIGGER branch_admin_requests_set_updated_at BEFORE UPDATE ON public.branch_admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS branch_announcements_set_updated_at ON public.branch_announcements;
CREATE TRIGGER branch_announcements_set_updated_at BEFORE UPDATE ON public.branch_announcements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: the Admin only ever its own branch ──
ALTER TABLE public.branch_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.branch_admin_requests, public.branch_announcements FROM anon, authenticated;

DROP POLICY IF EXISTS branch_admin_requests_read ON public.branch_admin_requests;
CREATE POLICY branch_admin_requests_read ON public.branch_admin_requests FOR SELECT TO authenticated
  USING (private.has_permission('branch_oversight', 'read') AND (
    (private.current_role_name() = 'admin' AND branch_id = private.current_branch_id())
    OR private.current_role_name() = 'hr'
    OR (private.current_role_name() = 'super_admin' AND kind = 'rfid_issue')
    OR (private.current_role_name() = 'accountant' AND branch_id = private.current_branch_id() AND kind = 'overtime_confirmation')));

DROP POLICY IF EXISTS branch_admin_requests_admin_insert ON public.branch_admin_requests;
CREATE POLICY branch_admin_requests_admin_insert ON public.branch_admin_requests FOR INSERT TO authenticated
  WITH CHECK (private.current_role_name() = 'admin' AND private.has_permission('branch_oversight', 'create')
    AND branch_id = private.current_branch_id() AND created_by = (SELECT auth.uid())
    AND status IN ('pending', 'endorsed', 'not_endorsed') AND decided_by IS NULL);

-- The Admin may change its own endorsement (still its branch, still undecided);
-- HR decides any; the Super Admin resolves RFID issues only.
DROP POLICY IF EXISTS branch_admin_requests_update ON public.branch_admin_requests;
CREATE POLICY branch_admin_requests_update ON public.branch_admin_requests FOR UPDATE TO authenticated
  USING (private.has_permission('branch_oversight', 'update') AND (
    (private.current_role_name() = 'admin' AND branch_id = private.current_branch_id() AND decided_by IS NULL)
    OR private.current_role_name() = 'hr'
    OR (private.current_role_name() = 'super_admin' AND kind = 'rfid_issue')))
  WITH CHECK (
    (private.current_role_name() = 'admin' AND branch_id = private.current_branch_id() AND decided_by IS NULL
      AND status IN ('pending', 'endorsed', 'not_endorsed'))
    OR private.current_role_name() = 'hr'
    OR (private.current_role_name() = 'super_admin' AND kind = 'rfid_issue'));

DROP POLICY IF EXISTS branch_announcements_read ON public.branch_announcements;
CREATE POLICY branch_announcements_read ON public.branch_announcements FOR SELECT TO authenticated
  USING (private.has_permission('announcements', 'read') AND (
    private.current_role_name() = 'hr'
    OR (branch_id = private.current_branch_id() AND (archived = FALSE OR private.current_role_name() = 'admin'))));

DROP POLICY IF EXISTS branch_announcements_admin_write ON public.branch_announcements;
CREATE POLICY branch_announcements_admin_write ON public.branch_announcements FOR INSERT TO authenticated
  WITH CHECK (private.current_role_name() = 'admin' AND private.has_permission('announcements', 'create')
    AND branch_id = private.current_branch_id() AND created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS branch_announcements_admin_update ON public.branch_announcements;
CREATE POLICY branch_announcements_admin_update ON public.branch_announcements FOR UPDATE TO authenticated
  USING (private.current_role_name() = 'admin' AND private.has_permission('announcements', 'update') AND branch_id = private.current_branch_id())
  WITH CHECK (private.current_role_name() = 'admin' AND branch_id = private.current_branch_id());

-- ── Permissions (src/lib/rbac/permissions.js) ──
INSERT INTO public.role_permissions (role, module, scope, can_create, can_read, can_update, can_delete) VALUES
  ('super_admin', 'branch_oversight', 'all', false, true, true, false),
  ('super_admin', 'announcements', 'none', false, false, false, false),
  ('admin', 'branch_oversight', 'branch', true, true, true, false),
  ('admin', 'announcements', 'branch', true, true, true, true),
  ('hr', 'branch_oversight', 'all', false, true, true, false),
  ('hr', 'announcements', 'all', false, true, false, false),
  ('accountant', 'branch_oversight', 'branch', false, true, false, false),
  ('accountant', 'announcements', 'branch', false, true, false, false),
  ('employee', 'branch_oversight', 'none', false, false, false, false),
  ('employee', 'announcements', 'self', false, true, false, false),
  ('admin', 'audit_logs', 'none', false, false, false, false)
ON CONFLICT (role, module) DO UPDATE SET
  scope      = EXCLUDED.scope,
  can_create = EXCLUDED.can_create,
  can_read   = EXCLUDED.can_read,
  can_update = EXCLUDED.can_update,
  can_delete = EXCLUDED.can_delete,
  updated_at = NOW();
