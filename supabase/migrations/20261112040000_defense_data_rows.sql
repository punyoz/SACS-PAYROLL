-- The defense-data tag (2026-11-12, Part 4): every row the defense script
-- ADDS for the original accounts (salary changes, attendance corrections,
-- audit entries ...) is listed here by table and id, so a later cleanup can
-- find exactly those rows. The rows themselves stay ordinary, live data (in
-- the backup and the reports). Only is_demo exists elsewhere (profiles), and
-- one list is lighter than a tag column on every table.
-- Server-only: no client access (like the other server-only tables).

CREATE TABLE IF NOT EXISTS public.defense_data_rows (
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  batch      TEXT NOT NULL DEFAULT 'defense-2026-11',
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (table_name, row_id)
);

ALTER TABLE public.defense_data_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS defense_data_rows_no_client_access ON public.defense_data_rows;
CREATE POLICY defense_data_rows_no_client_access ON public.defense_data_rows
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.defense_data_rows FROM anon, authenticated;
