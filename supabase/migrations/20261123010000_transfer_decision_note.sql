-- Batch 2 (2026-11-22): HR's remark when approving or rejecting a transfer
-- (a preset remark, Part H; required to reject). The decision's audit entry
-- is written by decision_remark_audit() (20261122030000), already on this
-- table. Additive: the current code never writes it.
ALTER TABLE public.transfer_requests ADD COLUMN IF NOT EXISTS decision_note TEXT;
