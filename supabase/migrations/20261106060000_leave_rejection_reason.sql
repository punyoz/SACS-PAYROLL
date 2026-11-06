-- Decision 2026-11-06: HR's leave rejection needs a reason the employee sees
-- (as a payroll rejection already does). PATCH /api/hr/leave-requests requires
-- 5-500 characters for "reject" and stores it here; the employee's leave list
-- and the rejection notice show it. Older rejections keep NULL.
-- Nullable, so no existing row changes.

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS decision_reason TEXT;

ALTER TABLE public.leave_requests
  DROP CONSTRAINT IF EXISTS leave_requests_decision_reason_length;

ALTER TABLE public.leave_requests
  ADD CONSTRAINT leave_requests_decision_reason_length
  CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500);

COMMENT ON COLUMN public.leave_requests.decision_reason IS
  'Why HR rejected the request (required on reject since 2026-11-06); shown to the employee.';
