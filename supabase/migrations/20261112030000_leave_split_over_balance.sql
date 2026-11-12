-- Leave over the yearly paid balance (decision 2026-11-12): never blocked.
-- At approval the server re-checks the balance; days past the paid days left
-- become leave WITHOUT pay in a second row linked to the approved one
-- (src/lib/leave-requests/store.js applyBalanceSplit). Payroll, attendance
-- and Final Pay keep reading pay_status per row. Existing rows are untouched
-- (split_from stays null): no past approved leave or payslip changes.

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS split_from UUID REFERENCES public.leave_requests(id);

COMMENT ON COLUMN public.leave_requests.split_from IS
  'The approved WITH-pay request these days were split from (the days over the yearly paid balance, without pay).';

CREATE INDEX IF NOT EXISTS leave_requests_split_from_idx ON public.leave_requests (split_from) WHERE split_from IS NOT NULL;
