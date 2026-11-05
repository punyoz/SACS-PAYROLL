# Backup and restore

The organization is on **Supabase Pro** (since 2026-11). Supabase takes a
daily backup of the whole project and keeps it **7 days**; it can be
restored from Dashboard → Database → Backups. The plan, the recovery plan
and who does what are in [hosting-and-operations.md](hosting-and-operations.md).

This page is the school's **own** backup, the second safety net: a full
export kept off-site, which survives even if the Supabase project is lost
and reaches further back than 7 days. **Real payroll data goes in only after
a restore has been tested** (section 3).

## 1. What Supabase Pro covers, and what it does not

| | Supabase daily backup | The school's export (this page) |
|---|---|---|
| Taken | every day, automatically | Fridays, the 14th and the day before month end (scheduled task, section 2), or by hand |
| Kept | 7 days | as long as the school keeps the files |
| Survives deleting the project | no | yes |
| Restores | the whole project, in place | into a new project or the local stack (section 3) |
| Storage files (profile pictures, leave proofs) | no | no (the database only) |

Database size is 8 GB on Pro (26 MB on 2026-11-05); growth estimates are in
hosting-and-operations.md section 6.

## 2. Backups

### Set up once

1. Install **Docker Desktop** and start it.
2. Dashboard → Project → **Connect** → *Session pooler*: copy the connection
   string, put the database password in it, and save it in `.env.local` as
   `SUPABASE_DB_URL=...` in **`.env.live.local`** (git-ignored; never on the
   host, never committed). `.env.local` is the local stack for development.
3. Decide where backups live: an encrypted USB drive or a restricted school
   Drive folder, plus one copy off-site. The files contain names, salaries
   and password hashes.
4. Save the ID-number key in the school's password manager. In the live
   project's SQL Editor run
   `select decrypted_secret from vault.decrypted_secrets where name = 'pii_encryption_key';`
   and store the value as "SACS payroll – pii_encryption_key". Without it a
   restored copy cannot read SSS, TIN, PhilHealth, Pag-IBIG or PRC
   numbers. It never changes, so this is a one-time step.

### Each backup

```powershell
npm run db:backup
```

It writes `backups/<date_time>/` (git-ignored) with `roles.sql`,
`schema.sql`, `data.sql`, the migration history and a `manifest.json` of
sizes and SHA-256 checksums. Copy the folder to the backup locations.

### Scheduled

`scripts/backup/install-scheduled-backup.ps1` (run once) registers the
Windows task **SACS Payroll backup**. It checks every day at 16:30 and backs
up on Fridays, the 14th and the day before the last day of the month, while
the user is signed in (it starts Docker Desktop if needed). Results go to
`%LOCALAPPDATA%SACS-Payrollackup.log`. Copy each new folder to the
off-site location.

### When

| When | Why |
|---|---|
| Every Friday afternoon | the week's attendance |
| Right after each payslip generation (the 15th and month end) | the payslips just locked |
| Before running any migration or SQL script | a way back |
| Before a school break | the project may be idle |

Keep the last 8 weekly backups and every month-end backup for the year.

## 3. Test a restore (before real data, then every term)

Use the **local Supabase stack** (free) or, with approval, a second project
(billed by the hour on Pro) as the target; never the live one.

- **R1.** Dashboard → New project, e.g. `sacs-restore-test`, same region
  (South Asia, Mumbai). Save its database password.
- **R2.** In it: Database → Extensions → enable `pg_cron`, `pgcrypto`,
  `supabase_vault` and `uuid-ossp`.
- **R3.** Copy its Session pooler connection string (Connect).
- **R4.** Install the PostgreSQL 17 client tools (for `psql`), then from the
  backup folder:

  ```powershell
  psql --single-transaction --variable ON_ERROR_STOP=1 `
    --file roles.sql --file schema.sql `
    --command "SET session_replication_role = replica" `
    --file data.sql `
    --dbname "<RESTORE-TEST connection string>"
  psql --single-transaction --variable ON_ERROR_STOP=1 `
    --file history_schema.sql --file history_data.sql `
    --dbname "<RESTORE-TEST connection string>"
  ```

  `session_replication_role = replica` keeps the triggers from firing on the
  restored rows (no double encryption, no append-only refusals). If `psql`
  stops on an `ALTER ... OWNER TO "supabase_admin"` line in `schema.sql`, or
  on `GRANT "postgres" TO "cli_login_postgres"` or
  `ALTER ROLE "supabase_admin" SET ...` in `roles.sql`, comment that
  line out and run again (Supabase's guide lists the first two; the third
  stopped the Oct 12, 2026 test).
- **R5.** In the restore project's SQL Editor open
  [scripts/backup/after-restore.sql](../scripts/backup/after-restore.sql),
  paste the saved key, and run it. It puts the key back, recreates the four
  scheduled jobs, removes the anon / authenticated grants the dump brings
  back (step 3 of the script) and prints the checks.
- **R6.** Pass when:
  - the counts match the live project's at backup time;
  - "scheduled jobs" is 4;
  - "client table grants" and "client-callable functions" are both 0;
  - "ID numbers that decrypt" equals "ID numbers stored";
  - pointing a local copy of the app at the restore project
    (`.env.local` with its URL and keys, `npm run dev`) lets the Super Admin
    sign in and open a payslip.
- **R7.** Delete the restore project afterwards (on Pro a second project is
  billed by the hour; a local stack costs nothing). Write the date and result in the backup log.

### Restore test log

| Date | Backup | Target | Result |
|---|---|---|---|
| 2026-10-12 | `backups/2026-10-12_audit` (taken with `supabase db dump --linked`) | fresh local Supabase stack (Docker, CLI 2.118.0) | **Pass, except the decrypt check.** Rows restored, with counts equal to live (12 accounts, 12 profiles, 4 branches, 130 attendance logs, 1105 audit logs, 2 payroll entries, 41 rate configs, 51 holidays, 84 migrations, 6 stored ID numbers); 4 jobs recreated; passwords for all five roles verify; service-role reads and RPCs work. The decrypt check was not run (the real `pii_encryption_key` was not used). The test found that the dump restores full anon/authenticated grants, so step 3 was added to after-restore.sql. |
| 2026-10-13 | same backup | fresh local Supabase stack | **Pass (R5 decrypt check).** Restored again; after-restore.sql steps 2–3: 4 jobs, 0 client grants; the live `pii_encryption_key` put into the restored Vault: 6 ID numbers stored = 6 that decrypt, 0 failures across all encrypted fields. The local stack and its volumes were deleted afterwards. |

## 4. Restore for real (the live project is lost or damaged)

1. Create a new project (R1–R5) from the latest good backup.
2. Settings → API: copy its URL, anon and service_role keys into the host's
   environment variables; redeploy.
3. Authentication → URL Configuration: Site URL = the payroll domain.
4. Tell staff to sign in again (old sessions are not valid).
5. Anything entered after the backup (taps, leave, payslips) must be
   re-entered from paper or the terminals' saved taps.

## 5. Uptime monitoring

Pro projects are never paused, so the Free-plan keep-alive ping (a daily
GitHub Actions job) was removed on 2026-11-05. Keep one uptime monitor so
someone hears when the site is down:

- a free UptimeRobot (or Better Stack) HTTP monitor on
  `https://<payroll-domain>/api/health` every 5 minutes. That endpoint runs
  one tiny database read and answers only up or down, and the monitor emails
  you if the site or the database is unreachable.
