-- Holidays: the nationwide special days fixed by law, and who added a holiday.
--
-- attendance_holidays held only the regular holidays (11 a year), so the
-- nightly close (attendance_close_days) wrote Absent for every employee on
-- the special non-working days, and payroll deducted them. These three are
-- set by law every year:
--
--   August 21    Ninoy Aquino Day                  (RA 9256, RA 9492)
--   December 8   Feast of the Immaculate Conception (RA 10966)
--   December 31  Last Day of the Year              (RA 9492, Proclamations)
--
-- The days that change every year (Eid'l Fitr, Eid'l Adha, Chinese New Year,
-- Black Saturday, All Souls' Day, Christmas Eve, and any day the President
-- declares) are added in Super Admin -> System Configuration -> Holidays from
-- that year's proclamation (/api/admin/holidays).
--
-- Safe to run more than once.

ALTER TABLE public.attendance_holidays ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.attendance_holidays ADD COLUMN IF NOT EXISTS created_by_name TEXT;

CREATE INDEX IF NOT EXISTS attendance_holidays_created_by_idx ON public.attendance_holidays (created_by);

INSERT INTO public.attendance_holidays (holiday_date, name, type, created_by_name) VALUES
  ('2026-08-21', 'Ninoy Aquino Day', 'special', 'System (fixed by law)'),
  ('2026-12-08', 'Feast of the Immaculate Conception', 'special', 'System (fixed by law)'),
  ('2026-12-31', 'Last Day of the Year', 'special', 'System (fixed by law)'),
  ('2027-08-21', 'Ninoy Aquino Day', 'special', 'System (fixed by law)'),
  ('2027-12-08', 'Feast of the Immaculate Conception', 'special', 'System (fixed by law)'),
  ('2027-12-31', 'Last Day of the Year', 'special', 'System (fixed by law)')
ON CONFLICT (holiday_date) DO NOTHING;
