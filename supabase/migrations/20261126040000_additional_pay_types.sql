-- 2026-11-26 (release 4): the Accountant's own Additional Pay types.
--  * additional_pay_types: name, taxable or not, description; deactivated (never deleted) once used.
--  * payroll_monthly_incentives: kind 'custom' with pay_type_id (the type) and non_taxable copied from the
--    type when filed (a later change to the type never changes a filed item). HR approves each item as before.
--  * "Adjustment" is no longer offered for new items (the app refuses it); old adjustments stay as they are.
-- Additive: no row is changed or removed.
CREATE TABLE IF NOT EXISTS public.additional_pay_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  taxable         BOOLEAN NOT NULL DEFAULT TRUE,
  description     TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS additional_pay_types_name_key ON public.additional_pay_types (lower(btrim(name)));
ALTER TABLE public.additional_pay_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.additional_pay_types FROM anon, authenticated;

ALTER TABLE public.payroll_monthly_incentives
  ADD COLUMN IF NOT EXISTS pay_type_id UUID REFERENCES public.additional_pay_types (id);

ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_kind_check;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_kind_check
  CHECK (kind = ANY (ARRAY['incentive', 'overload', 'honorarium', 'bonus', 'adjustment', 'custom']));

ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_value_chk;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_value_chk CHECK (
  ((kind = ANY (ARRAY['incentive', 'honorarium', 'bonus'])) AND amount > 0 AND hours IS NULL)
  OR (kind = 'overload' AND hours > 0 AND amount IS NULL)
  OR (kind = 'adjustment' AND amount <> 0 AND hours IS NULL AND char_length(btrim(COALESCE(reason, ''))) >= 5)
  OR (kind = 'custom' AND amount > 0 AND hours IS NULL AND pay_type_id IS NOT NULL)
);

ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_non_taxable_chk;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_non_taxable_chk
  CHECK (NOT non_taxable OR kind = ANY (ARRAY['adjustment', 'custom']));
