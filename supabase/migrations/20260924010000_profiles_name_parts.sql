-- ════════════════════════════════════════════════════════════════════════════
-- Split names on profiles: first_name, middle_name, last_name, suffix
--
-- WHY
-- The Super Admin "Add Staff Account" form (and its Edit dialog) now collects
-- First / Middle / Last / Suffix instead of one Full Name box. profiles.full_name
-- stays: it is what every table, report and session already displays (the
-- "User" column on Admin & HR Logins included), so it is kept as the composed
-- value rather than replaced.
--
-- HOW THE TWO STAY IN STEP (trigger profiles_00_sync_name_parts)
--   * A write that sets or changes any name part recomputes full_name from the
--     parts:  "First Middle Last Suffix", blanks skipped.
--   * A write that changes only full_name (the HR employee flow, profile
--     edits, older routes) re-splits it into the parts, best effort.
-- full_name is a plain column, not a GENERATED one, on purpose: several
-- existing routes write it directly, and a generated column would reject
-- those writes.
--
-- SPLITTING RULES (split_full_name, mirrored in src/lib/employees/staff-record.js)
--   1. A trailing Jr / Jr. / Sr / Sr. / II / III / IV / V is the suffix.
--   2. The last word is the last name, together with any surname particles
--      directly in front of it (Dela Cruz, De Los Santos, San Juan...).
--   3. If two or more words remain, the one nearest the last name is the
--      middle name and the rest is the first name; otherwise all of it is the
--      first name.
--   "Juan Santos Dela Cruz Jr." -> Juan | Santos | Dela Cruz | Jr.
-- A name that yields a part failing the CHECK rules below is left with all
-- parts NULL rather than stored half-split; full_name is untouched either way.
--
-- VALIDATION (server side, cannot be bypassed from the browser)
-- Each part: 1-50 characters, starts with a letter, then letters, spaces,
-- hyphens, apostrophes and periods only. Suffix: one of the fixed list. The
-- same rules are enforced by validateStaffRecord() before any write.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name  TEXT,
  ADD COLUMN IF NOT EXISTS middle_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name   TEXT,
  ADD COLUMN IF NOT EXISTS suffix      TEXT;

-- ── Helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_valid_name_part(value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = public
AS $$
  SELECT value IS NULL
      OR (
        char_length(value) BETWEEN 1 AND 50
        AND value ~ '^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .''-]*$'
      );
$$;

CREATE OR REPLACE FUNCTION public.compose_full_name(
  first_name TEXT, middle_name TEXT, last_name TEXT, suffix TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    concat_ws(' ',
      NULLIF(btrim(first_name), ''),
      NULLIF(btrim(middle_name), ''),
      NULLIF(btrim(last_name), ''),
      NULLIF(btrim(suffix), '')
    ),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.split_full_name(
  full_name TEXT,
  OUT first_name TEXT,
  OUT middle_name TEXT,
  OUT last_name TEXT,
  OUT suffix TEXT
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  tokens TEXT[];
  n INT;
  last_start INT;
  particles CONSTANT TEXT[] := ARRAY[
    'de', 'del', 'dela', 'della', 'delos', 'des', 'di', 'da', 'dos', 'das',
    'du', 'la', 'las', 'le', 'los', 'san', 'santa', 'sta.', 'sto.', 'van', 'von'
  ];
BEGIN
  tokens := regexp_split_to_array(btrim(COALESCE(full_name, '')), '\s+');
  n := COALESCE(array_length(tokens, 1), 0);
  IF n = 0 OR tokens[1] = '' THEN
    RETURN;
  END IF;

  IF n > 1 THEN
    suffix := CASE lower(tokens[n])
      WHEN 'jr' THEN 'Jr.' WHEN 'jr.' THEN 'Jr.'
      WHEN 'sr' THEN 'Sr.' WHEN 'sr.' THEN 'Sr.'
      WHEN 'ii' THEN 'II' WHEN 'iii' THEN 'III'
      WHEN 'iv' THEN 'IV' WHEN 'v' THEN 'V'
      ELSE NULL
    END;
    IF suffix IS NOT NULL THEN
      n := n - 1;
    END IF;
  END IF;

  IF n = 1 THEN
    first_name := tokens[1];
    RETURN;
  END IF;

  last_start := n;
  WHILE last_start > 2 AND lower(tokens[last_start - 1]) = ANY (particles) LOOP
    last_start := last_start - 1;
  END LOOP;

  last_name := array_to_string(tokens[last_start:n], ' ');

  IF last_start - 1 >= 2 THEN
    middle_name := tokens[last_start - 1];
    first_name := array_to_string(tokens[1:last_start - 2], ' ');
  ELSE
    first_name := array_to_string(tokens[1:last_start - 1], ' ');
  END IF;
END;
$$;

-- ── Backfill existing rows ─────────────────────────────────────────────────

UPDATE public.profiles AS p
SET first_name  = s.first_name,
    middle_name = s.middle_name,
    last_name   = s.last_name,
    suffix      = s.suffix
FROM public.profiles AS src
CROSS JOIN LATERAL public.split_full_name(src.full_name) AS s
WHERE p.id = src.id
  AND p.first_name IS NULL
  AND p.last_name IS NULL
  AND src.full_name IS NOT NULL
  AND btrim(src.full_name) <> ''
  AND public.is_valid_name_part(s.first_name)
  AND public.is_valid_name_part(s.middle_name)
  AND public.is_valid_name_part(s.last_name);

-- ── Constraints ────────────────────────────────────────────────────────────

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_first_name_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_first_name_valid
  CHECK (public.is_valid_name_part(first_name));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_middle_name_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_middle_name_valid
  CHECK (public.is_valid_name_part(middle_name));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_last_name_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_last_name_valid
  CHECK (public.is_valid_name_part(last_name));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_suffix_valid;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_suffix_valid
  CHECK (suffix IS NULL OR suffix IN ('Jr.', 'Sr.', 'II', 'III', 'IV', 'V'));

-- ── Keep full_name and the parts in step ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.profiles_sync_name_parts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parts RECORD;
  parts_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    parts_changed := COALESCE(NEW.first_name, NEW.middle_name, NEW.last_name, NEW.suffix) IS NOT NULL;
  ELSE
    parts_changed := NEW.first_name  IS DISTINCT FROM OLD.first_name
                  OR NEW.middle_name IS DISTINCT FROM OLD.middle_name
                  OR NEW.last_name   IS DISTINCT FROM OLD.last_name
                  OR NEW.suffix      IS DISTINCT FROM OLD.suffix;
  END IF;

  IF parts_changed AND (NEW.first_name IS NOT NULL OR NEW.last_name IS NOT NULL) THEN
    NEW.full_name := public.compose_full_name(NEW.first_name, NEW.middle_name, NEW.last_name, NEW.suffix);
  ELSIF NEW.full_name IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.full_name IS DISTINCT FROM OLD.full_name) THEN
    SELECT * INTO parts FROM public.split_full_name(NEW.full_name);
    IF public.is_valid_name_part(parts.first_name)
       AND public.is_valid_name_part(parts.middle_name)
       AND public.is_valid_name_part(parts.last_name) THEN
      NEW.first_name  := parts.first_name;
      NEW.middle_name := parts.middle_name;
      NEW.last_name   := parts.last_name;
      NEW.suffix      := parts.suffix;
    ELSE
      NEW.first_name  := NULL;
      NEW.middle_name := NULL;
      NEW.last_name   := NULL;
      NEW.suffix      := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_00_sync_name_parts ON public.profiles;
CREATE TRIGGER profiles_00_sync_name_parts
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_sync_name_parts();
