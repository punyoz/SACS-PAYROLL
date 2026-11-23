-- ═══════════════════════════════════════════════════════════════════════════
-- No part-time employees (user decision 2026-11-23). The Employment type field
-- is hidden everywhere; the stored value is Full-time for everyone. Not
-- destructive: the column, its check, the history and the Part-time rule rows
-- stay (they never match anyone). Live had no Part-time employee (read-only
-- check 2026-11-23); an empty value becomes Full-time, and new accounts get it.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ALTER COLUMN employment_type SET DEFAULT 'Full-time';

UPDATE public.profiles SET employment_type = 'Full-time' WHERE employment_type IS NULL;
