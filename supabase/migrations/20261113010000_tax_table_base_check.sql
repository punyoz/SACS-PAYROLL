-- Withholding tax table: each bracket's base tax must equal the tax at the top
-- of the bracket below (base + rate × width), so a version cannot carry a
-- typo such as ₱1 on the ₱20,833 bracket (test version deleted 2026-11-13).
-- Checked per version at commit, so a whole version is inserted first.
-- ₱0.50 tolerance: BIR tables round (RR 11-2018's 2018 table: 10,833.33 vs 10,833.50).
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.payroll_tax_brackets_base_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  bad RECORD;
BEGIN
  SELECT b.bracket_over, b.base_tax,
         ROUND(b.prev_base + b.prev_rate / 100 * (b.bracket_over - b.prev_over), 2) AS expected
    INTO bad
  FROM (
    SELECT bracket_over, base_tax,
           LAG(bracket_over) OVER w AS prev_over,
           LAG(base_tax) OVER w AS prev_base,
           LAG(rate_pct) OVER w AS prev_rate
    FROM public.payroll_tax_brackets
    WHERE version_id = NEW.version_id
    WINDOW w AS (ORDER BY bracket_over)
  ) b
  WHERE b.prev_over IS NOT NULL
    AND ABS(b.base_tax - (b.prev_base + b.prev_rate / 100 * (b.bracket_over - b.prev_over))) > 0.5
  ORDER BY b.bracket_over
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'tax_table_base_mismatch: the bracket over % has base tax %, but the bracket below ends at %.',
      bad.bracket_over, bad.base_tax, bad.expected
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payroll_tax_brackets_base_check ON public.payroll_tax_brackets;
CREATE CONSTRAINT TRIGGER payroll_tax_brackets_base_check
  AFTER INSERT OR UPDATE ON public.payroll_tax_brackets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payroll_tax_brackets_base_check();
