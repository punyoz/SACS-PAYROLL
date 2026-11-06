# Defense / demo notes: processing window enforcement

Normally, the Accountant can process payroll and change attendance overrides
only inside the **processing window**: the Payslip Schedule's generation day
through its last open day (Super Admin → System Configuration → Payroll →
Payslip Schedule). For testing and the final defense, the Super Admin can
switch that one rule OFF for a while.

## Turn it OFF (before the demo)

1. Sign in as **Super Admin** → **System Configuration** → **Payroll** tab.
2. Scroll to **Processing window enforcement** (it shows a green **ON** badge).
3. Type a **reason**, for example "Final defense demo".
4. Optional: pick **Turn back ON automatically on**. Use the day after the
   defense. The date is checked every time payroll is read, so the switch is
   back ON from that day even if the nightly job runs late.
5. Click **Turn OFF (testing mode)**. On the live system a confirmation box
   explains what OFF means; click **I understand, turn it OFF**.
6. A red banner now reads **"Testing mode: processing window not enforced."**
   on System Configuration, the Accountant's **Process Payroll** page and HR's
   **Payroll Approval** page.

On the local or demo stack you can also use the command line:

```
node scripts/window-enforcement.mjs off --reason "Defense demo" --until 2026-12-01
node scripts/window-enforcement.mjs status
```

## What OFF allows, and what it does not

- Allowed: the Accountant processes, generates, reprocesses and submits any
  cutoff of **their own branch** on any date. Absent, Late, Undertime, Half
  day and Leave without pay overrides work on any date, still with a
  required reason, and each one is logged.
- Unchanged: own branch only; government deductions and withholding tax stay
  read-only; leaving employees out of a run still needs the acknowledgment;
  HR still approves; the Accountant's own payslip is still system-computed
  only; approved payroll stays locked; the Final payslip override stays
  Super Admin only.
- Payslips and runs made while OFF are marked **created in testing mode**
  (`created_in_testing_mode` on `payroll_entries` and `payroll_runs`). HR sees
  a red **Testing mode** badge on those runs. Older records are not marked.

## Turn it back ON (after the demo)

1. Super Admin → System Configuration → Payroll → Processing window enforcement.
2. Type a reason, for example "Defense finished".
3. Click **Turn ON (enforce the window)**. The red banners disappear, and the
   window applies exactly as before.

Command line (local or demo only): `node scripts/window-enforcement.mjs on --reason "Defense finished"`.

Every change (who, when, old value, new value, reason) is in the switch's
change history on that card and in Audit & Monitoring
(`payroll_window_enforcement_changed`).
