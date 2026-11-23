# Transfer approval trigger: old vs new (migration 20261124070000)

The only non-additive change in Batch 3. It ships in **its own release**, never together with other migrations, and is applied to live only after an explicit yes.

## What changes

- **Old:** approving a transfer moves the employee's branch at once.
- **New:** the same, unless the transfer has an **effective date later than today**. Such a transfer is approved now, and the daily job `transfer_apply_due` moves it that morning.
- **Same as before:**
  - Every transfer with no effective date (all existing rows) or an effective date of today.
  - Pending and rejected transfers (nothing moves).
  - An already approved transfer (the trigger only acts when the status *changes to* approved).
- **New side effects** when a move happens now:
  - `applied_at` is set;
  - the active RFID card's branch moves;
  - a "by System" log entry is written;
  - an own-schedule flag is raised for HR.

## Side by side

**Old** (`supabase/migrations/20260910010000_transfer_requests_and_employee_contact.sql`):

```sql
CREATE OR REPLACE FUNCTION public.apply_transfer_request_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_at := NOW();

    UPDATE public.profiles
    SET branch_id = NEW.to_branch_id, updated_at = NOW()
    WHERE id = NEW.employee_id;
  END IF;

  RETURN NEW;
END;
$$;
```

**New** (`supabase/migrations/20261124070000_transfer_automation.sql`):

```sql
CREATE OR REPLACE FUNCTION public.apply_transfer_request_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.reviewed_at := NOW();
    IF COALESCE(NEW.effective_date, (NOW() AT TIME ZONE 'Asia/Manila')::DATE) <= (NOW() AT TIME ZONE 'Asia/Manila')::DATE THEN
      UPDATE public.profiles
      SET branch_id = NEW.to_branch_id, updated_at = NOW()
      WHERE id = NEW.employee_id;
      NEW.applied_at := NOW();
      PERFORM public.transfer_apply_followups(NEW, FALSE);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
```

The trigger itself (`transfer_requests_02_apply_approval`, BEFORE UPDATE) is not recreated: only the function behind it changes.

## Rollback

[`scripts/rollback/rollback-transfer-automation.sql`](../../scripts/rollback/rollback-transfer-automation.sql):
- restores the old function word for word;
- removes the daily job and the new functions.

The two new columns are kept, since the old code ignores them. Dropping them is optional and loses any effective dates already entered. A transfer approved for a later date that has not been applied yet would need HR to re-apply it by hand after a rollback; the rollback lists them first.

## Checks

[`scripts/checks/transfer-trigger-equivalence.sql`](../../scripts/checks/transfer-trigger-equivalence.sql):
- runs pending → approved, pending → rejected, pending (untouched), and approved → approved again (already applied) under the **old** function and then under the **new** one, in one rolled-back transaction;
- asserts identical outcomes (status, reviewed_at set or not, employee's branch);
- is run against a local copy of the live backup before any live step.
