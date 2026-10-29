-- Input limits from the reference table (2026-10-29), enforced by the database
-- as well as the form boxes and API routes (src/lib/input-limits.js holds the
-- same numbers).
--
-- Supersedes three limits of 20261029070000_input_length_limits.sql:
--   branches.name               80 -> 100, letters, digits, spaces, . ' -
--   leave_requests.reason      1,000 -> 500
--   payroll_rate_configs.value  9,999,999.99 -> 999,999.99 (contribution tables)
--
-- Peso amounts (a maximum value; the digit count follows):
--   profiles.basic_salary, employee_salary_changes.new_salary    1,000,000
--   payroll_loans.principal                  500,000 (cash-advance type 50,000)
--   payroll_cash_advances.principal                                  50,000
--   payroll_monthly_incentives.amount, early_bird_winners.amount,
--   early-bird / perfect-attendance rates                           100,000
--   rate configs, SSS salary-credit table, fixed contributions   999,999.99
--   13th month, corrections, teacher subsidy amounts              1,000,000
-- Identifiers:
--   profiles.cp_number          09 + 9 digits (one live number stored as
--                               "0917 ### ####" is stored without the spaces)
--   profiles.email              at most 254, name@domain.tld
--   profiles.employee_id        at most 20; letters/digits in dash groups
--   profiles.staff_id           at most 20
--   profiles.position           at most 100
--   SSS / PhilHealth / Pag-IBIG / TIN
--                               exactly 10 / 12 / 12 / 9 or 12 digits, checked in
--                               private.profiles_protect_pii() before encrypting
--                               (the plaintext columns are emptied there, so a
--                               table CHECK never sees them)
--   rfid_cards.uid              exactly 10 digits, as the school's readers send
--                               (rfid_uid_free() too)
--   rfid_terminals.name         2-50, letters, digits, spaces, . ' -
-- Counts:
--   attendance_corrections late / undertime minutes   0-1,440 (one day)
-- Text: reasons at most 500, notes and remarks at most their box (300-1,000).
--
-- Every constraint is dropped and added again (safe to run more than once),
-- added NOT VALID and then validated: if any existing row is outside its
-- limit, validation fails and the whole migration changes nothing.

-- ── 1. A contact number stored with spaces, stored as digits ─────────────
UPDATE public.profiles
SET cp_number = regexp_replace(cp_number, '[\s-]', '', 'g')
WHERE cp_number ~ '[\s-]'
  AND regexp_replace(cp_number, '[\s-]', '', 'g') ~ '^09[0-9]{9}$';

-- ── 2. Table limits ───────────────────────────────────────────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- People
      ('public.profiles', 'profiles_basic_salary_max', $c$basic_salary IS NULL OR basic_salary <= 1000000$c$),
      ('public.profiles', 'profiles_email_valid', $c$email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')$c$),
      ('public.profiles', 'profiles_cp_number_valid', $c$cp_number IS NULL OR cp_number = '' OR cp_number ~ '^09[0-9]{9}$'$c$),
      ('public.profiles', 'profiles_position_length', $c$position IS NULL OR char_length(position) <= 100$c$),
      ('public.profiles', 'profiles_employee_id_format', $c$employee_id IS NULL OR employee_id = '' OR (char_length(employee_id) <= 20 AND employee_id ~ '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$')$c$),
      ('public.profiles', 'profiles_staff_id_format', $c$staff_id IS NULL OR (char_length(staff_id) <= 20 AND staff_id ~ '^STAFF-[0-9]{3,}$')$c$),
      ('public.profiles', 'profiles_sss_number_check', $c$sss_number IS NULL OR sss_number::text ~ '^[0-9]{10}$'$c$),
      ('public.profiles', 'profiles_philhealth_number_check', $c$philhealth_number IS NULL OR philhealth_number::text ~ '^[0-9]{12}$'$c$),
      ('public.profiles', 'profiles_pagibig_number_check', $c$pagibig_number IS NULL OR pagibig_number::text ~ '^[0-9]{12}$'$c$),
      ('public.profiles', 'profiles_payroll_hold_reason_length', $c$payroll_hold_reason IS NULL OR char_length(payroll_hold_reason) <= 1000$c$),
      ('public.employee_salary_changes', 'employee_salary_changes_new_salary_check', $c$new_salary > 0 AND new_salary <= 1000000$c$),
      ('public.employee_status_changes', 'employee_status_changes_reason_length', $c$reason IS NULL OR char_length(reason) <= 1000$c$),
      ('public.employee_license_changes', 'employee_license_changes_reason_length', $c$reason IS NULL OR char_length(reason) <= 500$c$),
      ('public.employee_awol_cases', 'employee_awol_cases_notes_length', $c$notes IS NULL OR char_length(notes) <= 1000$c$),
      ('public.transfer_requests', 'transfer_requests_remarks_length', $c$remarks IS NULL OR char_length(remarks) <= 1000$c$),
      -- Branches, cards, terminals
      ('public.branches', 'branches_name_length', $c$char_length(btrim(name)) BETWEEN 1 AND 100 AND name ~ '^[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 .''-]*$'$c$),
      ('public.rfid_cards', 'rfid_cards_uid_check', $c$uid ~ '^[0-9]{10}$'$c$),
      ('public.rfid_cards', 'rfid_cards_status_reason_length', $c$status_reason IS NULL OR char_length(status_reason) <= 300$c$),
      ('public.rfid_terminals', 'rfid_terminals_name_check', $c$char_length(btrim(name)) BETWEEN 2 AND 50 AND name ~ '^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .''-]+$'$c$),
      ('public.branch_admin_requests', 'branch_admin_requests_notes_length', $c$(admin_note IS NULL OR char_length(admin_note) <= 1000) AND (decision_note IS NULL OR char_length(decision_note) <= 1000)$c$),
      ('public.branch_announcements', 'branch_announcements_text_length', $c$char_length(title) <= 150 AND char_length(body) <= 4000$c$),
      -- Attendance and leave
      ('public.leave_requests', 'leave_requests_reason_length', $c$reason IS NULL OR char_length(reason) <= 500$c$),
      ('public.attendance_corrections', 'attendance_corrections_minutes_max', $c$(corrected_late_minutes IS NULL OR corrected_late_minutes BETWEEN 0 AND 1440) AND (corrected_undertime_minutes IS NULL OR corrected_undertime_minutes BETWEEN 0 AND 1440)$c$),
      ('public.attendance_corrections', 'attendance_corrections_text_length', $c$(reason IS NULL OR char_length(reason) <= 500) AND (review_note IS NULL OR char_length(review_note) <= 500)$c$),
      ('public.attendance_holidays', 'attendance_holidays_name_length', $c$char_length(name) <= 100$c$),
      ('public.attendance_overtime_approvals', 'attendance_overtime_approvals_note_length', $c$note IS NULL OR char_length(note) <= 300$c$),
      ('public.work_schedules', 'work_schedules_note_length', $c$note IS NULL OR char_length(note) <= 500$c$),
      ('public.work_schedule_assignments', 'work_schedule_assignments_note_length', $c$note IS NULL OR char_length(note) <= 500$c$),
      ('public.school_break_periods', 'school_break_periods_note_length', $c$note IS NULL OR char_length(note) <= 500$c$),
      ('public.tenure_protection_grants', 'tenure_protection_grants_notes_length', $c$(notes IS NULL OR char_length(notes) <= 500) AND (revoke_notes IS NULL OR char_length(revoke_notes) <= 500)$c$),
      -- Loans, advances, incentives
      ('public.payroll_loans', 'payroll_loans_principal_max', $c$principal <= CASE WHEN loan_type = 'cash_advance' THEN 50000 ELSE 500000 END$c$),
      ('public.payroll_loans', 'payroll_loans_text_length', $c$(description IS NULL OR char_length(description) <= 200) AND (status_reason IS NULL OR char_length(status_reason) <= 1000) AND (decision_reason IS NULL OR char_length(decision_reason) <= 1000) AND (decision_note IS NULL OR char_length(decision_note) <= 1000)$c$),
      ('public.payroll_cash_advances', 'payroll_cash_advances_principal_max', $c$principal <= 50000$c$),
      ('public.payroll_cash_advances', 'payroll_cash_advances_text_length', $c$(description IS NULL OR char_length(description) <= 200) AND (status_reason IS NULL OR char_length(status_reason) <= 300)$c$),
      ('public.payroll_monthly_incentives', 'payroll_monthly_incentives_amount_max', $c$amount IS NULL OR amount <= 100000$c$),
      ('public.payroll_monthly_incentives', 'payroll_monthly_incentives_text_length', $c$(description IS NULL OR char_length(description) <= 200) AND (decision_note IS NULL OR char_length(decision_note) <= 500)$c$),
      ('public.early_bird_winners', 'early_bird_winners_amount_max', $c$amount IS NULL OR amount <= 100000$c$),
      -- Rate tables (Super Admin)
      ('public.payroll_rate_configs', 'payroll_rate_configs_value_max', $c$value <= 999999.99$c$),
      ('public.payroll_rate_configs', 'payroll_rate_configs_incentive_max', $c$rate_type NOT IN ('early_bird_bonus', 'perfect_attendance_bonus') OR value <= 100000$c$),
      ('public.payroll_rate_configs', 'payroll_rate_configs_note_length', $c$note IS NULL OR char_length(note) <= 300$c$),
      ('public.payroll_sss_msc_brackets', 'payroll_sss_msc_brackets_amount_max', $c$salary_from <= 999999.99 AND msc <= 999999.99$c$),
      ('public.payroll_sss_msc_brackets', 'payroll_sss_msc_brackets_note_length', $c$note IS NULL OR char_length(note) <= 300$c$),
      ('public.payroll_contribution_amounts', 'payroll_contribution_amounts_max', $c$COALESCE(sss, 0) <= 999999.99 AND COALESCE(philhealth, 0) <= 999999.99 AND COALESCE(pagibig, 0) <= 999999.99$c$),
      ('public.payroll_contribution_amounts', 'payroll_contribution_amounts_note_length', $c$note IS NULL OR char_length(note) <= 300$c$),
      ('public.payroll_tax_brackets', 'payroll_tax_brackets_note_length', $c$note IS NULL OR char_length(note) <= 300$c$),
      ('public.payroll_schedule_settings', 'payroll_schedule_settings_note_length', $c$note IS NULL OR char_length(note) <= 500$c$),
      ('public.payroll_subsidy_settings', 'payroll_subsidy_settings_limits', $c$annual_amount <= 1000000 AND (note IS NULL OR char_length(note) <= 500)$c$),
      -- Payroll records, corrections, overrides, subsidy
      ('public.payroll_thirteenth_month', 'payroll_thirteenth_month_amount_max', $c$amount <= 1000000$c$),
      ('public.payroll_corrections', 'payroll_corrections_amount_check', $c$amount > 0 AND amount <= 1000000$c$),
      ('public.payroll_corrections', 'payroll_corrections_decision_note_length', $c$decision_note IS NULL OR char_length(decision_note) <= 500$c$),
      ('public.payroll_final_overrides', 'payroll_final_overrides_reason_length', $c$char_length(reason) <= 500$c$),
      ('public.payroll_records', 'payroll_records_override_reason_length', $c$deviations IS NULL OR char_length(COALESCE(deviations->>'reason', '')) <= 500$c$),
      ('public.payroll_runs', 'payroll_runs_remarks_length', $c$remarks IS NULL OR char_length(remarks) <= 1000$c$),
      ('public.payroll_review_flags', 'payroll_review_flags_review_note_length', $c$review_note IS NULL OR char_length(review_note) <= 500$c$),
      ('public.payroll_subsidy_requests', 'payroll_subsidy_requests_limits', $c$amount <= 1000000 AND (reason IS NULL OR char_length(reason) <= 1000) AND (decision_note IS NULL OR char_length(decision_note) <= 1000)$c$),
      ('public.payroll_subsidy_adjustments', 'payroll_subsidy_adjustments_limits', $c$amount <= 1000000 AND (reason IS NULL OR char_length(reason) <= 1000) AND (decision_note IS NULL OR char_length(decision_note) <= 1000)$c$)
    ) AS v(tbl, con, def)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.con);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID', r.tbl, r.con, r.def);
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.con);
  END LOOP;
END $$;

-- ── 3. Government numbers: checked before they are encrypted ─────────────
-- The 20261014050000 trigger, with a format check on each number it stores.
CREATE OR REPLACE FUNCTION private.profiles_protect_pii()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  retired boolean := private.pii_plaintext_retired();
BEGIN
  IF TG_OP = 'INSERT' OR NEW.sss_number IS DISTINCT FROM OLD.sss_number THEN
    NEW.sss_number       := NULLIF(btrim(NEW.sss_number), '');
    IF NEW.sss_number !~ '^[0-9]{10}$' THEN
      RAISE EXCEPTION 'SSS number must be exactly 10 digits.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.sss_number_enc   := private.encrypt_pii(NEW.sss_number);
    NEW.sss_number_last4 := right(NEW.sss_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.philhealth_number IS DISTINCT FROM OLD.philhealth_number THEN
    NEW.philhealth_number       := NULLIF(btrim(NEW.philhealth_number), '');
    IF NEW.philhealth_number !~ '^[0-9]{12}$' THEN
      RAISE EXCEPTION 'PhilHealth number must be exactly 12 digits.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.philhealth_number_enc   := private.encrypt_pii(NEW.philhealth_number);
    NEW.philhealth_number_last4 := right(NEW.philhealth_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.pagibig_number IS DISTINCT FROM OLD.pagibig_number THEN
    NEW.pagibig_number       := NULLIF(btrim(NEW.pagibig_number), '');
    IF NEW.pagibig_number !~ '^[0-9]{12}$' THEN
      RAISE EXCEPTION 'Pag-IBIG number must be exactly 12 digits.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.pagibig_number_enc   := private.encrypt_pii(NEW.pagibig_number);
    NEW.pagibig_number_last4 := right(NEW.pagibig_number, 4);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.tin_number IS DISTINCT FROM OLD.tin_number THEN
    NEW.tin_number       := NULLIF(btrim(NEW.tin_number), '');
    IF NEW.tin_number !~ '^([0-9]{9}|[0-9]{12})$' THEN
      RAISE EXCEPTION 'TIN must be 9 digits, or 12 digits including the branch code.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.tin_number_enc   := private.encrypt_pii(NEW.tin_number);
    NEW.tin_number_last4 := right(NEW.tin_number, 4);
  END IF;

  IF retired THEN
    NEW.sss_number := NULL;
    NEW.philhealth_number := NULL;
    NEW.pagibig_number := NULL;
    NEW.tin_number := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

-- ── 4. RFID card numbers: exactly 10 digits ───────────────────────────────
-- The 20261021030000 function, with the 10-digit rule.
CREATE OR REPLACE FUNCTION public.rfid_uid_free(p_uid text, p_employee uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid TEXT := btrim(COALESCE(p_uid, ''));
  v_owner TEXT;
BEGIN
  IF v_uid !~ '^[0-9]{10}$' THEN
    RAISE EXCEPTION 'invalid: the RFID UID must be the card''s number: exactly 10 digits.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(NULLIF(p.full_name, ''), p.email) INTO v_owner
  FROM public.rfid_cards c JOIN public.profiles p ON p.id = c.employee_id
  WHERE c.uid = v_uid AND c.status = 'active' LIMIT 1;
  IF v_owner IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate: this card is already assigned to %.', v_owner USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rfid_cards c WHERE c.uid = v_uid AND c.status IN ('lost', 'replaced')) THEN
    RAISE EXCEPTION 'blocked: this card was reported lost or replaced and can never be used again.' USING ERRCODE = 'check_violation';
  END IF;
  -- An archived employee's old card number is released for reuse.
  UPDATE public.profiles SET rfid_uid = NULL WHERE rfid_uid = v_uid AND id <> p_employee AND COALESCE(archived, FALSE);
  IF EXISTS (SELECT 1 FROM public.profiles WHERE rfid_uid = v_uid AND id <> p_employee) THEN
    RAISE EXCEPTION 'duplicate: this card is already assigned to another employee.' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN v_uid;
END;
$function$;
