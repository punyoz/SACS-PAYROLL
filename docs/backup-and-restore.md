# Backup and restore (Supabase Free plan)

The project stays on the Free plan for now. Supabase keeps **no backup you
can download or restore** on Free, so the school keeps its own. **Real
payroll data goes in only after a restore has been tested** (section 3).

## 1. What the Free plan allows

| Limit | Free plan | Today | What happens at the limit |
|---|---|---|---|
| Database size | 500 MB | 18 MB | the database turns **read-only**: no taps, no payslips, until data is removed or the plan upgraded |
| Disk | 1 GB | — | includes the write-ahead log |
| Egress (data sent out) | 5 GB uncached + 5 GB cached / month | — | over-quota notice, then a grace period |
| Backups | none restorable | — | your own dumps only (this page) |
| Inactivity | paused after **7 days** of low database activity | — | the app stops working until someone resumes the project (possible for 90 days) |
| Projects | 2 active free projects per organization | 1 | the second is for restore tests |
| Support | community only | — | — |

Rough growth: about 100 staff × 260 days of attendance plus taps and audit
entries is tens of MB a year, so 500 MB lasts several years. Check
Dashboard → Reports → Database each month.

## 2. Backups

### Set up once

1. Install **Docker Desktop** and start it.
2. Dashboard → Project → **Connect** → *Session pooler*: copy the connection
   string, put the database password in it, and save it in `.env.local` as
   `SUPABASE_DB_URL=...` (never on the host, never committed).
3. Decide where backups live: an encrypted USB drive or a restricted school
   Drive folder, plus one copy off-site. The files contain names, salaries
   and password hashes.
4. Save the ID-number key in the school's password manager. In the live
   project's SQL Editor run
   `select decrypted_secret from vault.decrypted_secrets where name = 'pii_encryption_key';`
   and store the value as "SACS payroll – pii_encryption_key". Without it a
   restored copy cannot read SSS, TIN, PhilHealth, Pag-IBIG, bank or PRC
   numbers. It never changes, so this is a one-time step.

### Each backup

```powershell
npm run db:backup
```

It writes `backups/<date_time>/` (git-ignored) with `roles.sql`,
`schema.sql`, `data.sql`, the migration history and a `manifest.json` of
sizes and SHA-256 checksums. Copy the folder to the backup locations.

### When

| When | Why |
|---|---|
| Every Friday afternoon | the week's attendance |
| Right after each payslip generation (the 15th and month end) | the payslips just locked |
| Before running any migration or SQL script | a way back |
| Before a school break | the project may be idle |

Keep the last 8 weekly backups and every month-end backup for the year.

## 3. Test a restore (before real data, then every term)

Use a **second free project** as the target; never the live one.

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
  on `GRANT "postgres" TO "cli_login_postgres"` in `roles.sql`, comment that
  line out and run again (Supabase's guide lists both).
- **R5.** In the restore project's SQL Editor open
  [scripts/backup/after-restore.sql](../scripts/backup/after-restore.sql),
  paste the saved key, and run it. It puts the key back, recreates the four
  scheduled jobs and prints the checks.
- **R6.** Pass when:
  - the counts match the live project's at backup time;
  - "scheduled jobs" is 4;
  - "ID numbers that decrypt" equals "ID numbers stored";
  - pointing a local copy of the app at the restore project
    (`.env.local` with its URL and keys, `npm run dev`) lets the Super Admin
    sign in and open a payslip.
- **R7.** Pause or delete the restore project afterwards (Free allows two
  active projects). Write the date and result in the backup log.

## 4. Restore for real (the live project is lost or damaged)

1. Create a new project (R1–R5) from the latest good backup.
2. Settings → API: copy its URL, anon and service_role keys into the host's
   environment variables; redeploy.
3. Authentication → URL Configuration: Site URL = the payroll domain.
4. Tell staff to sign in again (old sessions are not valid).
5. Anything entered after the backup (taps, leave, payslips) must be
   re-entered from paper or the terminals' saved taps.

## 5. Keeping the project awake during breaks

Free projects pause after 7 days of low activity. Two pings keep it awake;
set up both:

- **Uptime monitor (main):** a free UptimeRobot (or Better Stack) HTTP
  monitor on `https://<payroll-domain>/api/health` every 5 minutes. That
  endpoint runs one tiny database read, so each check is real activity, and
  the monitor emails you if the site is down.
- **GitHub Actions (backup):** `.github/workflows/keep-alive.yml` calls the
  same endpoint once a day. In GitHub → Settings → Secrets and variables →
  Actions → Variables, add `HEALTH_URL` = `https://<payroll-domain>/api/health`.
  GitHub disables scheduled workflows after 60 days without commits in
  public repositories; re-enable it in the Actions tab if that happens.

Supabase emails the project owner about a week before it pauses a project;
opening the Dashboard also counts as activity. If it does pause: Dashboard →
the project → **Resume project** (a few minutes; data kept). That works for
**90 days** after the pause; after that only a downloadable file remains, so
never let it sit paused.
