-- 2026-11-26 (release 4): Bereavement leave, and which pool each leave type uses.
--  * statutory_leave_types.source: 'statutory' (the law) or 'school' (school policy). Both are filed per
--    event and never use the yearly leave-credits pool (5 / 3).
--  * Bereavement Leave: school policy, not statutory; days per event (HR edits it in Settings >
--    Classification rules; default 3, pending the policy manual); any employee.
--  * leave_requests.event_relationship / event_date: whose death and when (bereavement).
-- Additive: existing rows keep their values; nothing is removed.
ALTER TABLE public.statutory_leave_types
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'statutory';
ALTER TABLE public.statutory_leave_types DROP CONSTRAINT IF EXISTS statutory_leave_types_source_check;
ALTER TABLE public.statutory_leave_types
  ADD CONSTRAINT statutory_leave_types_source_check CHECK (source IN ('statutory', 'school'));

INSERT INTO public.statutory_leave_types (leave_type, enabled, days, basis, eligibility, max_events, note, sort_order, updated_by_name, source)
VALUES ('Bereavement Leave', TRUE, 3, 'event', 'any', NULL,
        'School policy (not statutory): for the death of a spouse, parent, child or sibling. Days pending policy manual.', 6, 'System', 'school')
ON CONFLICT (leave_type) DO NOTHING;

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS event_relationship TEXT,
  ADD COLUMN IF NOT EXISTS event_date DATE;
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_event_relationship_check;
ALTER TABLE public.leave_requests
  ADD CONSTRAINT leave_requests_event_relationship_check
  CHECK (event_relationship IS NULL OR event_relationship IN ('spouse', 'parent', 'child', 'sibling'));
