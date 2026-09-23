-- System configuration key-value store for the Super Admin config module.
-- Rows are keyed by (section, key) — upsert-safe.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.system_config (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  section    TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  CONSTRAINT system_config_section_key_unique UNIQUE (section, key)
);

ALTER TABLE public.system_config
  ADD COLUMN IF NOT EXISTS section    TEXT,
  ADD COLUMN IF NOT EXISTS key        TEXT,
  ADD COLUMN IF NOT EXISTS value      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

CREATE INDEX IF NOT EXISTS system_config_section_idx ON public.system_config (section);

-- Seed defaults so the config page has values on first load.
INSERT INTO public.system_config (section, key, value) VALUES
  -- General
  ('general',    'org_name',    'SACS'),
  ('general',    'timezone',    'Asia/Manila'),
  ('general',    'date_format', 'MM/DD/YYYY'),
  ('general',    'currency',    'PHP'),
  -- Attendance
  ('attendance', 'work_start',  '08:00'),
  ('attendance', 'work_end',    '17:00'),
  ('attendance', 'grace',       '15'),
  ('attendance', 'work_hours',  '8'),
  -- Payroll
  ('payroll',    'pay_freq',    'semi-monthly'),
  ('payroll',    'sss',         '4.5'),
  ('payroll',    'philhealth',  '2.0'),
  ('payroll',    'pagibig',     '2.0'),
  -- Security
  ('security',   'session',         '60'),
  ('security',   'login_attempts',  '5'),
  ('security',   'pw_min',          '8'),
  ('security',   'pw_expiry',       '0')
ON CONFLICT (section, key) DO NOTHING;
