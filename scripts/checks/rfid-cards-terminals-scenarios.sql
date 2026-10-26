-- ═══════════════════════════════════════════════════════════════════════════
-- Scenario checks for 20261021030000_rfid_cards_terminals.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LOCAL REPLAY ONLY (docs/local-migration-replay.md): never run against the
-- live project. Everything runs in one transaction and is rolled back.
--
--   npx supabase db reset
--   docker exec -i supabase_db_SACS-PAYROLL psql -U postgres -v ON_ERROR_STOP=1 < scripts/checks/rfid-cards-terminals-scenarios.sql
--
-- Ends with NOTICE "all RFID card and terminal scenarios passed".

BEGIN;

INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT ('00000000-0000-4000-8000-0000000d000' || n)::UUID, 'r' || n || '@rfid.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'
FROM generate_series(1, 9) n ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches (id, name, status) VALUES
  ('00000000-0000-4000-8000-0000000db001', 'RFID Main', 'Active'),
  ('00000000-0000-4000-8000-0000000db002', 'RFID North', 'Active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, branch_id, employee_type, position, basic_salary, employee_status) VALUES
  ('00000000-0000-4000-8000-0000000d0001', 'r1@rfid.test', 'Hana HR', 'hr', NULL, 'Non-Teaching', 'HR', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0002', 'r2@rfid.test', 'Sam Super', 'super_admin', NULL, 'Non-Teaching', 'SA', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0003', 'r3@rfid.test', 'Ada Main Admin', 'admin', '00000000-0000-4000-8000-0000000db001', 'Non-Teaching', 'Admin', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0004', 'r4@rfid.test', 'Ned North Admin', 'admin', '00000000-0000-4000-8000-0000000db002', 'Non-Teaching', 'Admin', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0005', 'r5@rfid.test', 'Acel Accountant', 'accountant', '00000000-0000-4000-8000-0000000db001', 'Non-Teaching', 'Accountant', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0006', 'r6@rfid.test', 'Emma Main', 'employee', '00000000-0000-4000-8000-0000000db001', 'Teaching', 'Teacher', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0007', 'r7@rfid.test', 'Ben Main', 'employee', '00000000-0000-4000-8000-0000000db001', 'Teaching', 'Teacher', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0008', 'r8@rfid.test', 'Nora North', 'employee', '00000000-0000-4000-8000-0000000db002', 'Teaching', 'Teacher', 1, 'Active'),
  ('00000000-0000-4000-8000-0000000d0009', 'r9@rfid.test', 'Cara Main', 'employee', '00000000-0000-4000-8000-0000000db001', 'Teaching', 'Teacher', 1, 'Active')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  hr    CONSTANT UUID := '00000000-0000-4000-8000-0000000d0001';
  sa    CONSTANT UUID := '00000000-0000-4000-8000-0000000d0002';
  adm   CONSTANT UUID := '00000000-0000-4000-8000-0000000d0003';
  admN  CONSTANT UUID := '00000000-0000-4000-8000-0000000d0004';
  acct  CONSTANT UUID := '00000000-0000-4000-8000-0000000d0005';
  emma  CONSTANT UUID := '00000000-0000-4000-8000-0000000d0006';
  ben   CONSTANT UUID := '00000000-0000-4000-8000-0000000d0007';
  nora  CONSTANT UUID := '00000000-0000-4000-8000-0000000d0008';
  cara  CONSTANT UUID := '00000000-0000-4000-8000-0000000d0009';
  main  CONSTANT UUID := '00000000-0000-4000-8000-0000000db001';
  north CONSTANT UUID := '00000000-0000-4000-8000-0000000db002';
  c1 public.rfid_cards; c2 public.rfid_cards; c3 public.rfid_cards; c4 public.rfid_cards;
  t1 public.rfid_terminals; t2 public.rfid_terminals;
  v_failed BOOLEAN;
  who UUID;
BEGIN
  -- 1. HR, the Super Admin and the branch's Admin each register a card.
  c1 := public.rfid_card_register(hr, emma, '1000000001', NULL);
  c2 := public.rfid_card_register(sa, nora, '1000000002', NULL);
  c3 := public.rfid_card_register(adm, ben, '1000000003', 'New hire');
  IF c1.registered_by_role <> 'hr' OR c2.registered_by_role <> 'super_admin' OR c3.registered_by_role <> 'admin' OR c3.registered_by_name <> 'Ada Main Admin' THEN
    RAISE EXCEPTION '1: registered by should keep the name and role';
  END IF;
  IF (SELECT rfid_uid FROM public.profiles WHERE id = emma) <> '1000000001' THEN RAISE EXCEPTION '1: the active card is what a tap matches'; END IF;

  -- 2. Another branch's Admin, the Accountant and an Employee cannot.
  FOREACH who IN ARRAY ARRAY[admN, acct, cara] LOOP
    v_failed := FALSE;
    BEGIN PERFORM public.rfid_card_register(who, cara, '1000000009', NULL); EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
    IF NOT v_failed THEN RAISE EXCEPTION '2: % must not register a Main card', who; END IF;
  END LOOP;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_set_status(admN, c1.id, 'deactivate', 'Not my branch'); EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '2: another branch''s Admin must not deactivate a Main card'; END IF;

  -- 3. One UID per person, one active card per person.
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_register(hr, cara, '1000000001', NULL); EXCEPTION WHEN unique_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '3: a UID already assigned must be refused'; END IF;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_register(hr, emma, '1000000099', NULL); EXCEPTION WHEN unique_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '3: a second active card must be refused'; END IF;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_register(hr, cara, '12AB', NULL); EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '3: a UID with letters must be refused'; END IF;

  -- 4. Replace a lost card: a reason is required; the old one never taps again.
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_replace(adm, c1.id, '1000000011', '', TRUE); EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '4: a replacement without a reason must be refused'; END IF;
  c4 := public.rfid_card_replace(adm, c1.id, '1000000011', 'Lost on the school bus', TRUE);
  SELECT * INTO c1 FROM public.rfid_cards WHERE id = c1.id;
  IF c1.status <> 'lost' OR c4.status <> 'active' OR c4.replaces_card_id <> c1.id THEN RAISE EXCEPTION '4: old lost, new active'; END IF;
  IF (SELECT rfid_uid FROM public.profiles WHERE id = emma) <> '1000000011' THEN RAISE EXCEPTION '4: taps should match the new card only'; END IF;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_register(hr, cara, '1000000001', NULL); EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '4: a lost card number must never be reused'; END IF;

  -- 5. Deactivate and reactivate.
  c3 := public.rfid_card_set_status(hr, c3.id, 'deactivate', 'Transferred to North');
  IF c3.status <> 'inactive' OR (SELECT rfid_uid FROM public.profiles WHERE id = ben) IS NOT NULL THEN RAISE EXCEPTION '5: deactivated card must not tap'; END IF;
  c3 := public.rfid_card_set_status(adm, c3.id, 'reactivate', 'Transfer cancelled');
  IF c3.status <> 'active' OR (SELECT rfid_uid FROM public.profiles WHERE id = ben) <> '1000000003' THEN RAISE EXCEPTION '5: reactivated card taps again'; END IF;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_card_set_status(hr, c3.id, 'deactivate', ''); EXCEPTION WHEN check_violation THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '5: a deactivation needs a reason'; END IF;

  -- 6. History: every action, with who, role, when and why.
  IF (SELECT count(*) FROM public.rfid_card_events) < 7 THEN RAISE EXCEPTION '6: every action must be in the history'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rfid_card_events WHERE card_id = c3.id AND action = 'reactivated' AND actor_role = 'admin' AND reason = 'Transfer cancelled') THEN
    RAISE EXCEPTION '6: the reactivation should keep who and why';
  END IF;

  -- 7. Nothing skips the functions.
  v_failed := FALSE;
  BEGIN UPDATE public.profiles SET rfid_uid = '1000000077' WHERE id = cara; EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '7: a direct card change on profiles must be refused'; END IF;
  v_failed := FALSE;
  BEGIN UPDATE public.rfid_cards SET status = 'active' WHERE id = c1.id; EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '7: a direct card change must be refused'; END IF;
  v_failed := FALSE;
  BEGIN DELETE FROM public.rfid_card_events WHERE card_id = c1.id; EXCEPTION WHEN OTHERS THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '7: the history must never be deleted'; END IF;

  -- 8. Terminals: an Admin adds for its own branch only; the Super Admin any, or every branch; HR changes any but adds none.
  t1 := public.rfid_terminal_save(adm, NULL, 'Main Gate', main, 'active', FALSE, NULL);
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_terminal_save(adm, NULL, 'North Gate', north, 'active', FALSE, NULL); EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: an Admin must not add another branch''s terminal'; END IF;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_terminal_save(admN, t1.id, 'Main Gate 2', main, 'inactive', FALSE, NULL); EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: another branch''s Admin must not change this terminal'; END IF;
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_terminal_save(acct, NULL, 'Office', main, 'active', FALSE, NULL); EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: the Accountant must not add a terminal'; END IF;
  -- HR no longer adds terminals (20261026010000); the Super Admin may add an every-branch one.
  v_failed := FALSE;
  BEGIN PERFORM public.rfid_terminal_save(hr, NULL, 'HR Office', NULL, 'active', FALSE, NULL); EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: HR must not add a terminal'; END IF;
  t2 := public.rfid_terminal_save(sa, NULL, 'HR Office', NULL, 'active', FALSE, NULL);
  IF t2.branch_id IS NOT NULL OR t2.created_by_role <> 'super_admin' THEN RAISE EXCEPTION '8: the Super Admin adds an every-branch terminal'; END IF;
  -- HR still renames / switches an existing terminal.
  t2 := public.rfid_terminal_save(hr, t2.id, 'HR Office 1', NULL, 'active', FALSE, NULL);
  IF t2.name <> 'HR Office 1' THEN RAISE EXCEPTION '8: HR renames a terminal'; END IF;
  t1 := public.rfid_terminal_save(sa, t1.id, 'Main Gate', main, 'inactive', FALSE, 'Reader broken');
  IF t1.status <> 'inactive' OR t1.key_version <> 2 THEN RAISE EXCEPTION '8: switching off locks out its kiosks (key %)', t1.key_version; END IF;
  t1 := public.rfid_terminal_save(adm, t1.id, 'Main Gate', main, 'active', TRUE, 'Reader replaced');
  IF t1.status <> 'active' OR t1.key_version <> 3 THEN RAISE EXCEPTION '8: a key reset bumps the key'; END IF;
  PERFORM public.rfid_terminal_touch(t1.id, 'time_in');
  IF (SELECT last_tap_at FROM public.rfid_terminals WHERE id = t1.id) IS NULL THEN RAISE EXCEPTION '8: last tap time'; END IF;
  v_failed := FALSE;
  BEGIN UPDATE public.rfid_terminals SET status = 'active' WHERE id = t1.id; EXCEPTION WHEN insufficient_privilege THEN v_failed := TRUE; END;
  IF NOT v_failed THEN RAISE EXCEPTION '8: a direct terminal change must be refused'; END IF;

  RAISE NOTICE 'all RFID card and terminal scenarios passed';
END $$;

ROLLBACK;
