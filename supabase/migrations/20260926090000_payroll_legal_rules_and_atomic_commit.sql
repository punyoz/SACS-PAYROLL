-- ═══════════════════════════════════════════════════════════════════════════
-- Payroll: legal contribution tables, overtime and holiday pay, salary-based
-- daily rate, and all-or-nothing payslip processing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. New effective-dated rate types (Super Admin → Payroll Rates):
--
--      overtime_premium_pct          approved overtime is paid at the hourly
--                                    rate plus this % (25 → 125%)
--      regular_holiday_premium_pct   work on a regular holiday: + this % of the
--                                    daily rate (100 → double pay)
--      special_holiday_premium_pct   work on a special day: + this % (30)
--      sss_msc_min / sss_msc_max     SSS monthly salary credit range
--      philhealth_floor / _ceiling   PhilHealth salary floor and ceiling
--      pagibig_max_salary            Pag-IBIG maximum fund salary
--      working_days_per_year         daily rate = monthly salary x 12 / this
--
--    sss_pct, philhealth_pct and pagibig_pct keep their names but, from
--    2026-10-01, mean the EMPLOYEE SHARE of the legal base (SSS: of the
--    monthly salary credit; PhilHealth: of the salary within floor/ceiling;
--    Pag-IBIG: of the salary up to the maximum fund salary), not a flat % of
--    the half-month basic. New versions carrying the legal values take effect
--    on 2026-10-01 (src/lib/payroll/statutory.js LEGAL_RULES_EFFECTIVE), so
--    payslips of earlier periods are computed exactly as before.
--
-- 2. attendance_overtime_approvals: overtime is paid only for minutes HR or an
--    Administrator approved. Kept in its own table so approving never touches
--    attendance_logs (whose status trigger would otherwise recompute a
--    corrected day).
--
-- 3. payroll_incentives accepts the two new earning lines, 'overtime' and
--    'holiday_premium', each tied to the attendance log it came from.
--
-- 4. payroll_commit_entries(): writes a processed payslip -- payroll_records
--    row, payslip number, payroll_entries row and every deduction/incentive
--    line -- in one transaction per employee. Before, the record was inserted
--    first and the entry synced after; a failure in between left a payslip
--    number with no visible payslip and blocked every retry as "already
--    processed". Payslip numbers are taken under a transaction lock, so two
--    accountants processing at once can no longer collide.
--
-- Safe to run more than once.

-- ── 1. Rate types ──────────────────────────────────────────────────────────

ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_rate_type_check;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_rate_type_check CHECK (rate_type IN (
  'hourly', 'daily', 'half_day_pct', 'absent_pct', 'late_days_per_absent',
  'late_minute_charge_pct', 'early_bird_bonus', 'perfect_attendance_bonus',
  'sss_pct', 'philhealth_pct', 'pagibig_pct',
  'overtime_premium_pct', 'regular_holiday_premium_pct', 'special_holiday_premium_pct',
  'sss_msc_min', 'sss_msc_max', 'philhealth_floor', 'philhealth_ceiling',
  'pagibig_max_salary', 'working_days_per_year'
));

ALTER TABLE public.payroll_rate_configs DROP CONSTRAINT IF EXISTS payroll_rate_configs_days_chk;
ALTER TABLE public.payroll_rate_configs ADD CONSTRAINT payroll_rate_configs_days_chk CHECK (
  rate_type <> 'working_days_per_year' OR (value = trunc(value) AND value BETWEEN 1 AND 366)
);

INSERT INTO public.payroll_rate_configs (rate_type, scope, scope_ref, value, effective_date, note, created_by_name)
SELECT v.rate_type, 'global', NULL, v.value, DATE '2026-10-01', v.note, 'System (legal tables)'
FROM (VALUES
  ('sss_pct',                     5.00,   'Employee share: 5% of the monthly salary credit'),
  ('philhealth_pct',              2.50,   'Employee share: 2.5% of monthly basic salary (half of 5%)'),
  ('pagibig_pct',                 2.00,   'Employee share: 2% of monthly salary up to the maximum fund salary'),
  ('sss_msc_min',                 5000,   'Lowest SSS monthly salary credit'),
  ('sss_msc_max',                 35000,  'Highest SSS monthly salary credit'),
  ('philhealth_floor',            10000,  'PhilHealth income floor'),
  ('philhealth_ceiling',          100000, 'PhilHealth income ceiling'),
  ('pagibig_max_salary',          10000,  'Pag-IBIG maximum fund salary'),
  ('overtime_premium_pct',        25,     'Overtime: hourly rate + 25%'),
  ('regular_holiday_premium_pct', 100,    'Work on a regular holiday: + 100% of the daily rate'),
  ('special_holiday_premium_pct', 30,     'Work on a special day: + 30% of the daily rate'),
  ('working_days_per_year',       261,    'Daily rate = monthly salary x 12 / 261 (Monday to Friday)')
) AS v(rate_type, value, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rate_configs c
  WHERE c.rate_type = v.rate_type AND c.scope = 'global' AND c.effective_date = DATE '2026-10-01'
);

-- ── 2. Overtime approvals ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.attendance_overtime_approvals (
  log_id            UUID PRIMARY KEY REFERENCES public.attendance_logs(id),
  employee_id       UUID NOT NULL REFERENCES public.profiles(id),
  branch_id         UUID REFERENCES public.branches(id),
  log_date          DATE NOT NULL,
  overtime_minutes  INTEGER NOT NULL CHECK (overtime_minutes >= 0),
  approved_minutes  INTEGER NOT NULL DEFAULT 0
                    CHECK (approved_minutes >= 0 AND approved_minutes <= overtime_minutes),
  status            TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  note              TEXT,
  decided_by        UUID REFERENCES public.profiles(id),
  decided_by_name   TEXT,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status = 'approved' OR approved_minutes = 0)
);

CREATE INDEX IF NOT EXISTS attendance_overtime_approvals_employee_date_idx
  ON public.attendance_overtime_approvals (employee_id, log_date);
CREATE INDEX IF NOT EXISTS attendance_overtime_approvals_branch_idx
  ON public.attendance_overtime_approvals (branch_id);
CREATE INDEX IF NOT EXISTS attendance_overtime_approvals_decided_by_idx
  ON public.attendance_overtime_approvals (decided_by);

-- Server only (service role), like attendance_corrections.
ALTER TABLE public.attendance_overtime_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_overtime_approvals FROM anon, authenticated;

-- ── 3. Earning lines ───────────────────────────────────────────────────────

ALTER TABLE public.payroll_incentives DROP CONSTRAINT IF EXISTS payroll_incentives_type_check;
ALTER TABLE public.payroll_incentives ADD CONSTRAINT payroll_incentives_type_check CHECK (type IN (
  'early_bird', 'perfect_attendance', 'overtime', 'holiday_premium'
));

-- ── 4. All-or-nothing payslip processing ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_commit_entries(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_record JSONB;
  v_entry JSONB;
  v_results JSONB := '[]'::JSONB;
  v_processed_at TIMESTAMPTZ;
  v_prefix TEXT;
  v_seq INTEGER;
  v_payslip TEXT;
  v_record_id UUID;
  v_entry_id UUID;
BEGIN
  -- One payslip-number sequence at a time: held until this transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('public.payroll_commit_entries'));

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) LOOP
    v_record := v_item->'record';
    v_entry := v_item->'entry';

    -- Each employee is its own subtransaction: a failure undoes everything
    -- written for that employee and nothing written for the others.
    BEGIN
      v_processed_at := COALESCE(NULLIF(v_record->>'processed_at', '')::TIMESTAMPTZ, NOW());
      v_prefix := 'PS-' || to_char(v_processed_at AT TIME ZONE 'Asia/Manila', 'YYYYMM') || '-';
      SELECT COALESCE(MAX(NULLIF(regexp_replace(substr(payslip_no, length(v_prefix) + 1), '\D', '', 'g'), '')::INTEGER), 0) + 1
        INTO v_seq
        FROM public.payroll_records
       WHERE payslip_no LIKE v_prefix || '%';
      v_payslip := v_prefix || lpad(v_seq::TEXT, 4, '0');

      INSERT INTO public.payroll_records (
        employee_id, employee_name, employee_type, gross_pay, total_deductions, net_pay,
        period_label, processed_at, payslip_no, base_pay, total_incentives,
        period_start, period_end, rate_version_snapshot, attendance_snapshot, deviations,
        processed_by, processed_by_name
      ) VALUES (
        (v_record->>'employee_id')::UUID,
        COALESCE(v_record->>'employee_name', ''),
        v_record->>'employee_type',
        COALESCE(NULLIF(v_record->>'gross_pay', '')::NUMERIC, 0),
        COALESCE(NULLIF(v_record->>'total_deductions', '')::NUMERIC, 0),
        COALESCE(NULLIF(v_record->>'net_pay', '')::NUMERIC, 0),
        v_record->>'period_label',
        v_processed_at,
        v_payslip,
        NULLIF(v_record->>'base_pay', '')::NUMERIC,
        COALESCE(NULLIF(v_record->>'total_incentives', '')::NUMERIC, 0),
        NULLIF(v_record->>'period_start', '')::DATE,
        NULLIF(v_record->>'period_end', '')::DATE,
        NULLIF(v_record->'rate_version_snapshot', 'null'::JSONB),
        NULLIF(v_record->'attendance_snapshot', 'null'::JSONB),
        NULLIF(v_record->'deviations', 'null'::JSONB),
        NULLIF(v_record->>'processed_by', '')::UUID,
        v_record->>'processed_by_name'
      )
      RETURNING id INTO v_record_id;

      INSERT INTO public.payroll_entries (
        id, employee_id, employee_name, employee_code, employee_type, position, pay_period,
        status, approval_id, payslip_no, payroll, submitted_at, created_at, updated_at
      ) VALUES (
        (v_entry->>'id')::UUID,
        (v_entry->>'employee_id')::UUID,
        v_entry->>'employee_name',
        NULLIF(v_entry->>'employee_code', ''),
        NULLIF(v_entry->>'employee_type', ''),
        NULLIF(v_entry->>'position', ''),
        v_entry->>'pay_period',
        (v_entry->>'status')::public.payroll_state,
        NULLIF(v_entry->>'approval_id', ''),
        v_payslip,
        v_entry->'payroll',
        NULLIF(v_entry->>'submitted_at', '')::TIMESTAMPTZ,
        COALESCE(NULLIF(v_entry->>'created_at', '')::TIMESTAMPTZ, NOW()),
        COALESCE(NULLIF(v_entry->>'updated_at', '')::TIMESTAMPTZ, NOW())
      )
      ON CONFLICT (employee_id, pay_period) DO UPDATE SET
        employee_name = EXCLUDED.employee_name,
        employee_code = EXCLUDED.employee_code,
        employee_type = EXCLUDED.employee_type,
        position      = EXCLUDED.position,
        status        = EXCLUDED.status,
        approval_id   = EXCLUDED.approval_id,
        payslip_no    = EXCLUDED.payslip_no,
        payroll       = EXCLUDED.payroll,
        submitted_at  = EXCLUDED.submitted_at,
        updated_at    = EXCLUDED.updated_at
      RETURNING id INTO v_entry_id;

      INSERT INTO public.payroll_deductions (
        payroll_record_id, payroll_entry_id, employee_id, pay_period, period_start, period_end,
        type, quantity, unit, rate, rate_config_id, amount, source_log_id, source_log_ids, is_override, note
      )
      SELECT v_record_id, v_entry_id, (v_entry->>'employee_id')::UUID, v_entry->>'pay_period',
             NULLIF(v_record->>'period_start', '')::DATE, NULLIF(v_record->>'period_end', '')::DATE,
             l->>'type', NULLIF(l->>'quantity', '')::NUMERIC, l->>'unit', NULLIF(l->>'rate', '')::NUMERIC,
             NULLIF(l->>'rate_config_id', '')::UUID, COALESCE(NULLIF(l->>'amount', '')::NUMERIC, 0),
             NULLIF(l->>'source_log_id', '')::UUID,
             CASE WHEN jsonb_typeof(l->'source_log_ids') = 'array' AND jsonb_array_length(l->'source_log_ids') > 0
                  THEN ARRAY(SELECT jsonb_array_elements_text(l->'source_log_ids')::UUID) END,
             COALESCE((l->>'is_override')::BOOLEAN, FALSE), l->>'note'
        FROM jsonb_array_elements(COALESCE(v_item->'deductions', '[]'::JSONB)) AS l;

      INSERT INTO public.payroll_incentives (
        payroll_record_id, payroll_entry_id, employee_id, pay_period, period_start, period_end,
        type, quantity, unit, rate, rate_config_id, amount, source_log_id, source_log_ids, is_override, note
      )
      SELECT v_record_id, v_entry_id, (v_entry->>'employee_id')::UUID, v_entry->>'pay_period',
             NULLIF(v_record->>'period_start', '')::DATE, NULLIF(v_record->>'period_end', '')::DATE,
             l->>'type', NULLIF(l->>'quantity', '')::NUMERIC, l->>'unit', NULLIF(l->>'rate', '')::NUMERIC,
             NULLIF(l->>'rate_config_id', '')::UUID, COALESCE(NULLIF(l->>'amount', '')::NUMERIC, 0),
             NULLIF(l->>'source_log_id', '')::UUID,
             CASE WHEN jsonb_typeof(l->'source_log_ids') = 'array' AND jsonb_array_length(l->'source_log_ids') > 0
                  THEN ARRAY(SELECT jsonb_array_elements_text(l->'source_log_ids')::UUID) END,
             COALESCE((l->>'is_override')::BOOLEAN, FALSE), l->>'note'
        FROM jsonb_array_elements(COALESCE(v_item->'incentives', '[]'::JSONB)) AS l;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'employee_id', v_entry->>'employee_id',
        'ok', TRUE,
        'record_id', v_record_id,
        'entry_id', v_entry_id,
        'payslip_no', v_payslip
      ));
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'employee_id', v_entry->>'employee_id',
        'ok', FALSE,
        'code', SQLSTATE,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN v_results;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_commit_entries(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_commit_entries(JSONB) TO service_role;
