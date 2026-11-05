# Hosting and operations

How the SACS Payroll Management System is hosted, backed up, monitored and
paid for. Written so it can be quoted in the capstone paper and used to
answer the panel question *"How will this system be hosted, backed up, and
paid for?"*

Verified against the live project on **2026-11-05**. Figures marked
*(dashboard)* cannot be read through the API this project uses and must be
checked by hand in the Supabase Dashboard.

## The short answer (for the panel)

> The web application runs on Vercel and the database, sign-in and file
> storage run on **Supabase Pro** (USD 25 a month, which includes the
> smallest database server). Supabase takes a **daily backup kept for
> 7 days**. On top of that, the school keeps its own encrypted copy of the
> whole database, taken before every payroll closing and stored off-site.
> A **spend cap** stops usage charges, so the bill stays at the plan fee
> unless the school chooses to add something. Every add-on that costs extra
> is listed below with its price and needs the school's approval first.

## 1. The plan and what it includes

| Item | Value |
|---|---|
| Supabase organization | Capstone, plan **Pro** |
| Project | Capstone Project, ref `swtlmaupaarrppypxsip`, status Active / Healthy |
| Region | `ap-south-1`, **South Asia (Mumbai)** |
| Postgres | 17.6 |
| Compute | **Micro**: 2 shared CPU cores, 1 GB RAM, 60 direct connections, 200 pooler connections |
| Disk | 2 GB provisioned (gp3, 3,000 IOPS); grows automatically |
| Web host | Vercel, `https://sacs-payroll.vercel.app` |

What the Pro fee includes, per month, for the whole organization:

| Included | Amount | Used today (2026-11-05) |
|---|---|---|
| Database size (disk) | 8 GB per project | 26 MB |
| File storage | 100 GB | 40 kB (2 profile pictures) |
| Egress (data sent out) | 250 GB | *(dashboard)*, about 4,400 API requests a day during testing |
| Monthly active users | 100,000 | 13 accounts |
| Edge Function invocations | 2,000,000 | 0 in the last 24 h (the nightly close runs inside the database) |
| Compute credit | USD 10 | covers the Micro instance (~USD 10) |
| Daily backups | kept 7 days | 8 listed, latest 2026-11-05 08:49 Manila |
| Log retention | 7 days | n/a (see section 7) |

### Region

Mumbai is about 5,000 km from Manila, twice as far as Singapore
(`ap-southeast-1`), which adds very roughly 50 to 100 ms to each request. The app works
from Mumbai and all testing was done there. Moving would mean creating a new
project in Singapore and migrating the data and accounts, so **the region is
kept**. Revisit only if staff report slow pages. To keep the extra delay to
one trip, the web server should run near the database (Vercel function region
Mumbai `bom1`, or the planned host in Mumbai).

## 2. Backups and recovery

Payroll data must always be recoverable. There are two independent copies.

### Copy 1: Supabase daily backups (automatic)

- Taken every day around 08:50 Manila time and kept **7 days**. Checked
  2026-11-05 through the Management API: 8 completed physical backups,
  2026-10-29 to 2026-11-05. Point-in-time recovery is **off**.
- A backup restores **the whole project** to that day. Anything entered
  after the backup (taps, leave, payslips) is lost and must be re-entered.
- Storage files (profile pictures) are **not** in these backups.
- These backups disappear if the project is deleted.

### Copy 2: the school's own export (manual, off-site)

`npm run db:backup` (see [backup-and-restore.md](backup-and-restore.md))
writes a full copy to `backups/<date_time>/`: roles, schema, **every row of
every table** (including all audit tables), the migration history, and a
checksum manifest. It only reads the database. It needs Docker Desktop and
the database connection string in `.env.local`.

It runs **automatically**: the Windows task *SACS Payroll backup* (installed
2026-11-05 by `scripts/backup/install-scheduled-backup.ps1`) checks every day
at 16:30 and backs up on:

| When | Why |
|---|---|
| The 14th and the day before the last day of the month | the payslips about to be locked |
| Every Friday | the week's attendance |
| By hand, before applying any migration | a way back |

The live connection string is read only from `.env.live.local`; results go
to `backup.log` in the `SACS-Payroll` folder under `%LOCALAPPDATA%`. The PC
must be on and signed in (a missed run starts at the next sign-in). Copying
each new folder off-site is still a person's job.

The files hold names, salaries and password hashes. Keep them on an
**encrypted** USB drive or a restricted school folder, plus one copy off-site,
never in e-mail or chat. The ID-number encryption key is **not** in the
export: it is kept separately in the school's password manager
(backup-and-restore.md, "Set up once", step 4). Keep the last 8 weekly
copies and every month-end copy for the school year.

### Recovery plan

| Situation | What to do | Who | Data lost |
|---|---|---|---|
| A wrong change made today (e.g. a bad import) | Dashboard → Database → Backups → restore last night's backup. The app is offline during the restore (minutes at this size). | Super Admin with the Supabase login, after telling HR and Accountants to stop work | everything since the backup (at most about one day) |
| Need data from more than 7 days ago | Restore the school's own export into a **new** project (backup-and-restore.md, R1 to R6), then copy back only what is needed | developer / IT | none for that data |
| The Supabase project is lost | Restore the latest school export into a new project, point the app at it (backup-and-restore.md section 4) | developer / IT | everything since that export |
| A Final payslip is wrong | Not a restore: the Accountant files a correction that appears on the next payslip | Accountant, approved by HR | none |

After any restore: the scheduled jobs and keys are checked with
`scripts/backup/after-restore.sql`, staff sign in again, and entries made
after the backup are re-entered from the RFID terminals' saved taps or paper.

A **restore test** must go to a separate target. A local Supabase stack
(Docker) costs nothing and was used on 2026-10-12/13 (passed). A Supabase
branch or second project costs money (section 9) and needs approval.

### Point-in-time recovery (PITR): recommendation **no, for now**

| | |
|---|---|
| Price | USD 100 a month for 7 days (USD 200 for 14, USD 400 for 28), **plus** a Small compute upgrade it requires (about USD 5 more a month after the credit). About **USD 105 a month extra**, not covered by the spend cap. |
| For | Restore to any second, not just last night. At most about 2 minutes of work lost instead of up to a day. |
| Against | Costs 5 times the plan. The school's data changes in small, re-enterable batches (taps, a few leave requests, two payroll runs a month); the RFID terminals keep their own taps; payslips are locked after approval and corrections go on the next payslip. A day of loss is recoverable by hand. |
| Recommendation | Keep daily backups plus the school's export before every payroll closing. Reconsider PITR if the school ever processes payroll several times a day or the database grows past a few GB. |

## 3. Security settings (2026-11-05)

- Row Level Security is **on for all 67 tables** in `public`. Clients have no
  direct table access; every read and write goes through the app's server
  routes, which check the role and branch.
- Database security advisor: **clean** since 2026-11-05 (migration
  `20261105010000` stated the last missing policy; leaked-password
  protection turned on).
- Sign-in: password plus an e-mailed code (Gmail), 8-character minimum with
  upper, lower, digit and symbol, an app-level breached-password check
  (HaveIBeenPwned range API), refresh-token rotation, and the app's own
  session limit.
- Redirect URLs list only the production domain and `localhost:3000`.

Settings changed on 2026-11-05 (all free on Pro):

| Setting | Before | Now | Why |
|---|---|---|---|
| Leaked-password protection (Supabase) | off | **on** | second layer behind the app's own check |
| Allow new users to sign up | on | **off** | the app never uses public sign-up; staff accounts are created on the server (admin API), which still works. Checked: a public sign-up attempt is refused (`signup_disabled`). |
| Enforce SSL on database connections | off | **on** | the backup script was re-run afterwards and succeeded |
| Redirect URLs | included `localhost:3000/supabase-status` | production domain and `localhost:3000` only | leftover development page |

Still open: the Auth server's database connections are a fixed 10; switch
to a percentage only if the compute size is ever upgraded.

## 4. Performance and connections

- The web app talks to the database through Supabase's HTTPS API, never
  through a direct database connection, so many users at once do not use up
  Postgres connections. The only direct connection is the backup script, and
  it uses the **Supavisor pooler** (`aws-1-ap-south-1.pooler.supabase.com`).
- Limits on Micro: 60 direct Postgres connections, 200 pooler connections.
  12 were in use when checked.
- Cache hit rate 99.9% for tables and indexes. The slowest statements on live
  are one-off administrative scripts, not app requests.
- Scale test (local, 2026-10-22/28): 1,210 employees, 5 years, 1.56 million
  attendance rows (about 2 GB). Most pages about 0.8 s; Accountant pages 1 to
  8 s; Payroll Reports and HR Payroll Records about 23 s because of the BIR
  forms card (known, fix proposed). This ran on a laptop, not on Micro. A
  load test on a temporary Micro branch was approved by the school
  (about USD 0.05) but **not run yet**: creating the branch needs a separate
  permission in the developer's tool. Until then, "Micro is enough" is an
  estimate, not a measurement.
- **Development** runs against the free local Supabase stack (`.env.local`);
  the live project's settings are kept apart in `.env.live.local`, read only
  by the backup.

## 5. Storage

| Bucket | Public | Size limit | Types | Links |
|---|---|---|---|---|
| `profile-photos` | no | 2 MB | `image/webp` (the server converts uploads) | signed, expiring |
| `leave-proofs` | no | 2 MB | `application/pdf`, `image/png`, `image/jpeg` | none: sent only through `/api/hr/leave-requests/proof` after the role and branch checks |

- **Leave proof documents** filed from 2026-11-05 are files in the private
  `leave-proofs` bucket (migration `20261105030000`); the row keeps only the
  path. The server also checks that the file really is a PDF, PNG or JPEG by
  its first bytes. HR's list no longer carries the files: a proof is fetched
  only when HR clicks View. The 3 proofs filed earlier stay inside their rows
  (nothing was moved or deleted).
- **Payslip and report PDFs** are generated in the browser and downloaded;
  nothing is stored.

## 6. How long the included amounts last

Assumptions: 4 branches; from the scale test, about **0.33 MB of database per
employee per year** (attendance, taps, payslips, audit); each employee files
**2 leave requests with proof a year at about 0.7 MB each** (the live average);
one profile picture of about 0.2 MB per person.

| Limit | 200 employees | 500 employees |
|---|---|---|
| Database 8 GB | ~66 MB/yr → **over 100 years** (about 20 years if proofs had stayed in the database) | ~165 MB/yr → **about 48 years** (about 8 years before) |
| File storage 100 GB | ~280 MB/yr of proofs + ~40 MB of pictures → **about 300 years** | ~700 MB/yr + ~100 MB → **about 140 years** |
| Egress 250 GB/month | estimate 5 to 10 GB/month → **not reached** | estimate 12 to 25 GB/month → **not reached** |
| Monthly active users 100,000 | 200 → not reached | 500 → not reached |
| Edge Function calls 2 million | ~0 (manual re-runs only) | ~0 |

Leave proofs were about 80% of the expected database growth. Since
2026-11-05 they go to the private bucket (100 GB), so the database grows
only about 66 MB a year at 200 staff and 165 MB at 500: **8 GB lasts
decades**. The bucket gains the 280 to 700 MB a year instead, far inside
100 GB.

Exceeding 8 GB is not a cliff on Pro: extra disk is billed (USD 0.125 per GB
per month), and with the spend cap on it is limited instead.

## 7. Audit trail and logs

Supabase keeps its own logs only **7 days**; the system does not rely on
them. Every record that must last is a row in the school's own database:
`audit_logs`, `employee_salary_changes`, `payroll_final_overrides`,
`payroll_corrections`, `branch_announcements`, `holiday_duty_history`,
`rfid_card_events`, `attendance_corrections`, the rate tables (each change is
a new dated row). Those tables are in the daily backups and in every
`npm run db:backup` export.

## 8. Scheduled jobs (pg_cron, inside the database)

| Job | When (Manila) | Last result | Failures, 30 days |
|---|---|---|---|
| `attendance-nightly-close` | daily 00:05 | succeeded 2026-11-05 | 0 of 30 |
| `awol-flag-candidates` | daily 00:20 | succeeded 2026-11-05 | 0 of 27 |
| `teacher-license-daily` | daily 00:30 | succeeded 2026-11-05 | 0 of 27 |
| `holiday-calendar-next-year` | Dec 1, 00:10 | not yet due | — |

The Edge Function `attendance-nightly` is active but only for re-running a
date range by hand; the nightly job does not use it.

## 9. Monthly cost

| Item | Monthly (USD) |
|---|---|
| Supabase Pro plan | 25 |
| Micro compute | ~10 |
| Compute credit | −10 |
| Usage over the included amounts | 0 (spend cap on) |
| **Supabase total** | **25** |
| Vercel | Hobby (free) during testing; production host per [hosting.md](hosting.md) |

Every billed option, none enabled:

| Option | Monthly (USD) | Covered by spend cap? | Recommendation |
|---|---|---|---|
| Point-in-time recovery, 7 days | 100 (+ Small compute ~5) | no | no (section 2) |
| Compute Small (2 GB RAM) | ~15 (~5 after credit) | no | not now; only if the load test or dashboard shows sustained CPU/RAM pressure |
| Compute Medium (4 GB RAM) | ~60 (~50 after credit) | no | no |
| Custom domain for Supabase API | 10 | no | no: users never see the Supabase address |
| Dedicated IPv4 | 4 | no | no: the pooler already gives IPv4 |
| Log drain | 60 + 0.20 per million events | no | no: the audit trail is in the database |
| Separate staging project (Micro) | ~10 | no | no: test on the free local stack instead |
| Temporary branch (Micro) | ~0.0134 per hour while it exists | no | only for a one-off load or restore test, deleted the same day |
| Phone MFA | 75 first project | no | no |

### The spend cap

When **on**, Supabase stops a usage item (database disk, egress, storage,
monthly active users, Edge Function calls, Realtime, logs) at the plan's
included amount instead of charging for more; service for that item is
limited until the next billing month. It does **not** cover compute,
branches, read replicas, point-in-time recovery, custom domains, IPv4, log
drains, extra disk IOPS/throughput or phone MFA: those are billed whenever
they are switched on. Keep it on (Dashboard → Organization → Billing →
Cost Control).

## 10. Monthly checklist (first school day of the month, 15 minutes)

- [ ] Organization → **Billing**: plan Pro, spend cap **on**, upcoming invoice
      about USD 25, no unexpected line items.
- [ ] Organization → **Usage**: egress, database size, storage, monthly active
      users all far below the included amounts.
- [ ] Project → **Branches**: none running (delete any left after a test).
- [ ] Project → Settings → **Add-ons**: none enabled unless approved.
- [ ] Database → **Backups**: 7 daily backups listed, the latest from today.
- [ ] Two school exports from this month (`npm run db:backup`) saved off-site.
- [ ] **Advisors** (Security and Performance): no new errors or warnings.
- [ ] Scheduled jobs: Super Admin SQL Editor →
      `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 12;`
      all `succeeded`.
- [ ] Reports → **Database**: CPU and memory not near the top of the chart
      on payroll days.
- [ ] Organization → **Team**: only the people who need access.

Supabase sends e-mail when an organization nears a quota; make sure the
billing e-mail in Organization → Billing is one the school reads.
