-- ═══════════════════════════════════════════════════════════════════════════
-- Final payslip lock
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A Final payslip (payroll_entries.status = 'paid') could be changed or
-- deleted by anyone with direct database access, as long as its branch's
-- payroll run was not Pending or Approved (payroll_run_lock_guard). The app
-- already refused it; now the database does too (user's decision, Oct 15, 2026).
--
--   1. public.payroll_commit_entries  unchanged except one line: it sets
--                                     sacs.payroll_commit for its own
--                                     transaction. It is the only writer of
--                                     Final payslips (Process, Reprocess and
--                                     the Super Admin override all go
--                                     through it). Body copied from the live
--                                     function (= 20261009020000).
--   2. public.payroll_entries_final_lock  BEFORE UPDATE OR DELETE: a 'paid'
--                                     row is refused unless
--                                       - payroll_commit_entries is writing it, or
--                                       - a payroll run action is (HR approval,
--                                         payroll_run_action_on()), or
--                                       - only updated_at / approved_by /
--                                         submitted_by change (the SET NULL
--                                         when an approver's profile is deleted).
--                                     Drafts are not affected.
--
-- Safe to run more than once.

-- ── 1. The commit function, marking its own writes ────────────────────────

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
  v_employee UUID;
  v_period_start DATE;
  v_line JSONB;
  v_old RECORD;
  v_amount NUMERIC;
BEGIN
  -- One payslip-number sequence at a time: held until this transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('public.payroll_commit_entries'));
  -- A Final payslip may be rewritten only here (payroll_entries_final_lock).
  PERFORM set_config('sacs.payroll_commit', 'on', true);

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

      -- ── Loan repayments (20261009010000 payroll_loan_payments) ──────────
      v_employee := (v_entry->>'employee_id')::UUID;
      v_period_start := NULLIF(v_record->>'period_start', '')::DATE;

      IF v_period_start IS NOT NULL THEN
        -- An overridden payslip replaces its own repayments: reverse them first.
        FOR v_old IN
          SELECT p.id, p.loan_id FROM public.payroll_loan_payments p
           WHERE p.employee_id = v_employee AND p.kind = 'payroll'
             AND p.period_start = v_period_start AND NOT p.reversed
        LOOP
          INSERT INTO public.payroll_loan_payments
            (loan_id, employee_id, kind, amount, reverses_payment_id, payroll_entry_id, pay_period, note,
             created_by, created_by_name)
          VALUES
            (v_old.loan_id, v_employee, 'reversal', 0, v_old.id, v_entry_id, v_entry->>'pay_period',
             'Payslip regenerated: repayment replaced',
             NULLIF(v_record->>'processed_by', '')::UUID, v_record->>'processed_by_name');
        END LOOP;
      END IF;

      FOR v_line IN SELECT value FROM jsonb_array_elements(COALESCE(v_item->'loan_payments', '[]'::JSONB)) LOOP
        v_amount := COALESCE(NULLIF(v_line->>'amount', '')::NUMERIC, 0);
        CONTINUE WHEN v_amount <= 0;
        INSERT INTO public.payroll_loan_payments
          (loan_id, employee_id, kind, period_start, pay_period, payroll_entry_id, amount_due, amount, note,
           created_by, created_by_name)
        VALUES
          ((v_line->>'loan_id')::UUID, v_employee, COALESCE(v_line->>'kind', 'payroll'),
           CASE WHEN COALESCE(v_line->>'kind', 'payroll') = 'payroll' THEN v_period_start END,
           v_entry->>'pay_period', v_entry_id,
           GREATEST(COALESCE(NULLIF(v_line->>'amount_due', '')::NUMERIC, v_amount), 0), v_amount,
           v_line->>'note',
           NULLIF(v_record->>'processed_by', '')::UUID, v_record->>'processed_by_name');
      END LOOP;

      -- ── Teacher subsidy year-end payout ─────────────────────────────────
      IF jsonb_typeof(v_item->'subsidy') = 'object' AND NULLIF(v_item->'subsidy'->>'balance_id', '') IS NOT NULL THEN
        UPDATE public.payroll_subsidy_balances
           SET paid_out        = GREATEST(COALESCE(NULLIF(v_item->'subsidy'->>'payout', '')::NUMERIC, 0), 0),
               paid_out_on     = COALESCE(NULLIF(v_item->'subsidy'->>'paid_on', '')::DATE, (v_processed_at AT TIME ZONE 'Asia/Manila')::DATE),
               status          = 'paid_out',
               payout_entry_id = v_entry_id,
               status_reason   = 'Paid on ' || (v_entry->>'pay_period'),
               updated_at      = NOW()
         WHERE id = (v_item->'subsidy'->>'balance_id')::UUID
           AND employee_id = v_employee
           AND (status = 'open' OR payout_entry_id = v_entry_id);
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Subsidy balance % is not open for this teacher.', v_item->'subsidy'->>'balance_id';
        END IF;
      END IF;

      -- ── Missed-month subsidy adjustments (Admin-approved) ───────────────
      UPDATE public.payroll_subsidy_adjustments a
         SET status = 'applied',
             payroll_entry_id = v_entry_id,
             applied_period_start = v_period_start,
             applied_at = NOW()
       WHERE a.employee_id = v_employee
         AND a.status = 'approved'
         AND a.id IN (SELECT value::UUID FROM jsonb_array_elements_text(COALESCE(v_item->'subsidy_adjustments', '[]'::JSONB)));

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

-- ── 2. The lock ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_entries_final_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.status IS DISTINCT FROM 'paid'::public.payroll_state THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF public.payroll_run_action_on() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('sacs.payroll_commit', true) = 'on' THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'approved_by', 'submitted_by'])
       = (to_jsonb(OLD) - ARRAY['updated_at', 'approved_by', 'submitted_by']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'payslip_final_locked: the % payslip of % is Final and cannot be %.',
    OLD.pay_period, COALESCE(OLD.employee_name, OLD.employee_id::text),
    CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END
    USING ERRCODE = 'check_violation';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.payroll_entries_final_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payroll_entries_zz_final_lock ON public.payroll_entries;
CREATE TRIGGER payroll_entries_zz_final_lock
  BEFORE UPDATE OR DELETE ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_final_lock();
