-- ═══════════════════════════════════════════════════════════════════════════
-- Card history: "Test lost-card report removed" (2026-11-24). The three test
-- lost reports removed on live this morning (audit action
-- rfid_lost_report_removed) show as a history entry, not a silent gap.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.rfid_card_events DROP CONSTRAINT IF EXISTS rfid_card_events_action_check;
ALTER TABLE public.rfid_card_events ADD CONSTRAINT rfid_card_events_action_check
  CHECK (action = ANY (ARRAY['registered', 'replaced', 'deactivated', 'reactivated', 'marked_lost', 'imported', 'lost_report_removed']));

DO $$
BEGIN
  PERFORM set_config('sacs.rfid_flow', 'on', true);
  INSERT INTO public.rfid_card_events (card_id, employee_id, branch_id, action, from_status, to_status, uid_last4, reason, actor_id, actor_name, actor_role, created_at)
  SELECT c.id, c.employee_id, c.branch_id, 'lost_report_removed', 'lost', 'inactive', c.uid_last4,
         'Test lost-card report removed (was "' || COALESCE(a.metadata->>'old_reason', '') || '")',
         NULL, 'System (at the owner''s request)', 'system', a.created_at
  FROM public.audit_logs a
  JOIN public.rfid_cards c ON c.id::text = a.entity_id
  WHERE a.action = 'rfid_lost_report_removed'
    AND NOT EXISTS (SELECT 1 FROM public.rfid_card_events e WHERE e.card_id = c.id AND e.action = 'lost_report_removed');
  PERFORM set_config('sacs.rfid_flow', '', true);
END $$;
