-- Rollback for release 4 (2026-11-26): migrations 20261126030000 (bereavement leave) and
-- 20261126040000 (additional pay types). Code: redeploy the previous production deployment (named in the
-- release report). No data step to undo.
--
-- Rows created after the release are kept and made valid for the old schema:
--  * leave requests of type "Bereavement Leave" stay (leave_type is free text); their relationship and
--    date of death are dropped with the columns (listed by the SELECT below first, to keep a copy);
--  * Additional Pay items of an own pay type become kind 'incentive' with the type's name in front of
--    the description (still paid; taxable, as the old schema allows non-taxable only for adjustments).
BEGIN;

-- A copy of what the columns held (shown in the output of this script).
SELECT id, employee_name, leave_type, start_date, end_date, event_relationship, event_date
  FROM public.leave_requests WHERE event_relationship IS NOT NULL OR event_date IS NOT NULL;
SELECT i.id, i.employee_id, i.item_date, i.description, i.amount, i.non_taxable, t.name AS pay_type
  FROM public.payroll_monthly_incentives i JOIN public.additional_pay_types t ON t.id = i.pay_type_id;

-- 20261126040000
ALTER TABLE public.payroll_monthly_incentives DISABLE TRIGGER USER;
UPDATE public.payroll_monthly_incentives i
   SET kind = 'incentive', non_taxable = FALSE,
       description = left(t.name || ': ' || i.description, 200)
  FROM public.additional_pay_types t
 WHERE i.kind = 'custom' AND t.id = i.pay_type_id;
ALTER TABLE public.payroll_monthly_incentives ENABLE TRIGGER USER;
ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_non_taxable_chk;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_non_taxable_chk
  CHECK (NOT non_taxable OR kind = 'adjustment');
ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_value_chk;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_value_chk CHECK (
  ((kind = ANY (ARRAY['incentive', 'honorarium', 'bonus'])) AND amount > 0 AND hours IS NULL)
  OR (kind = 'overload' AND hours > 0 AND amount IS NULL)
  OR (kind = 'adjustment' AND amount <> 0 AND hours IS NULL AND char_length(btrim(COALESCE(reason, ''))) >= 5)
);
ALTER TABLE public.payroll_monthly_incentives DROP CONSTRAINT IF EXISTS payroll_monthly_incentives_kind_check;
ALTER TABLE public.payroll_monthly_incentives ADD CONSTRAINT payroll_monthly_incentives_kind_check
  CHECK (kind = ANY (ARRAY['incentive', 'overload', 'honorarium', 'bonus', 'adjustment']));
ALTER TABLE public.payroll_monthly_incentives DROP COLUMN IF EXISTS pay_type_id;
DROP TABLE IF EXISTS public.additional_pay_types;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261126040000';

-- 20261126030000
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_event_relationship_check;
ALTER TABLE public.leave_requests DROP COLUMN IF EXISTS event_relationship;
ALTER TABLE public.leave_requests DROP COLUMN IF EXISTS event_date;
DELETE FROM public.statutory_leave_types WHERE leave_type = 'Bereavement Leave';
ALTER TABLE public.statutory_leave_types DROP CONSTRAINT IF EXISTS statutory_leave_types_source_check;
ALTER TABLE public.statutory_leave_types DROP COLUMN IF EXISTS source;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261126030000';
COMMIT;
