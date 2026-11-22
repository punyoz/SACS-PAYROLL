-- Part B, step 2 (2026-11-22): a half-day leave is a one-day leave request
-- with the half it covers (AM or PM). It counts as 0.5 day of leave
-- (src/lib/leave-requests/split.js requestDays); "with pay" uses 0.5 credit,
-- "without pay" is deducted at the half-day rate.
ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS half_day TEXT;
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_half_day_check;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_half_day_check
  CHECK (half_day IS NULL OR (half_day IN ('AM', 'PM') AND start_date = end_date));
