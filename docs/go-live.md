# Go-live guide

Everything needed to move SACS Payroll from test data to real use, in order.
Steps marked **(you)** need a person with the Supabase / Vercel / Gmail
logins; nothing here runs on its own.

Live project: `swtlmaupaarrppypxsip` (Supabase, region ap-south-1 Mumbai).

## 0. Before the day

- [ ] **Supabase plan.** The Free plan has no downloadable or restorable
      backups and pauses a project after 7 days of low activity (a school
      break is enough). Upgrade the organization to **Pro** (Dashboard →
      Organization → Billing). Pro keeps 7 days of daily backups; add
      Point-in-Time Recovery later if a day of lost data is too much.
- [ ] **Vercel plan.** Hobby is for personal, non-commercial use. A school's
      payroll should run on **Pro**.
- [ ] **Accounts.** Turn on MFA for the Supabase, Vercel, GitHub and Gmail
      accounts. Add a second owner to the Supabase organization and the Vercel
      team, so one lost phone does not lock the school out.
- [ ] **Migration history** repaired and the search_path fix applied, as in
      [local-migration-replay.md](local-migration-replay.md).
- [ ] **Holidays.** Super Admin → System Configuration → Holidays: add the
      proclaimed days for the rest of 2026 and for 2027 (e.g. All Souls' Day,
      Christmas Eve, Eid'l Fitr / Adha, Chinese New Year) once announced. The
      calendar seeds only the days fixed by law.
- [ ] **Subsidy year.** If the licensed-teacher subsidy starts this year,
      Super Admin → System Configuration → Payroll → Licensed Teacher Subsidy
      (no subsidy year is set up yet).
- [ ] **Branch RFID kits** ready (section 7).

## 1. Back up (go-live day, first)

### Pro plan

Dashboard → Database → Backups: confirm today's daily backup exists. You can
restore from it (the project is offline while it restores).

### Any plan: your own copy (keep it off the laptop too)

Needs Docker Desktop running, and `SUPABASE_ACCESS_TOKEN` set:

```powershell
npx supabase link --project-ref swtlmaupaarrppypxsip
npx supabase db dump --linked -f backup-roles.sql --role-only
npx supabase db dump --linked -f backup-schema.sql
npx supabase db dump --linked -f backup-data.sql --use-copy --data-only
```

Without Docker, install the PostgreSQL 17 client tools and use the
connection string from Dashboard → Connect → Session pooler:

```powershell
pg_dump "postgresql://postgres.swtlmaupaarrppypxsip:<DB-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" -Fc -f sacs-before-go-live.dump
```

**Save the PII encryption key separately.** SSS, TIN, PhilHealth, Pag-IBIG,
bank and PRC numbers are encrypted with a Vault key that only exists in this
project. A backup restored into a *new* project cannot decrypt them without
it. In the SQL Editor run:

```sql
select decrypted_secret from vault.decrypted_secrets where name = 'pii_encryption_key';
```

Copy the value into the school's password manager (not a file, not chat).

## 2. Clear the test data

1. **(you)** Create the real Super Admin: Super Admin → Admin & HR Accounts →
   **Add staff account**, with the school's real email (not a mail.tm or example.com address),
   then sign in with it once (password + emailed code) and change the issued
   password.
2. Open [scripts/go-live/clear-test-data.sql](../scripts/go-live/clear-test-data.sql)
   in the Supabase SQL Editor. In step 1 put that Super Admin's email.
3. Run it. It is a **dry run**: it stops with an error listing the before and
   after counts, and saves nothing. Check: accounts kept = your Super
   Admin(s); every KEEP row unchanged.
4. Set `dry_run` to `FALSE` in step 1 and run it again.
5. Sign in again as the Super Admin and check the dashboards are empty.

### What must still be there (seed checklist)

| Item | Where to check | Expected |
|---|---|---|
| 4 branches, real names and addresses | Super Admin → Branch Management | 4 |
| Role permissions | Super Admin → Roles & Permissions | matrix unchanged (138 rows) |
| System settings | System Configuration → General / Attendance / Security | branch schedules, session timeout 60 min, 5 login attempts |
| Payroll rates from Oct 1, 2026 | System Configuration → Rates | Working days per year 261; SSS ₱400, PhilHealth ₱0, Pag-IBIG ₱200 fixed; overtime 0% |
| Withholding tax table | System Configuration → Tax & contributions | BIR monthly table (0 / 15 / 20 / 25 / 30 / 35%) |
| Payslip schedule | System Configuration → Payroll → Payslip Schedule | defaults: 15th (next working day), month end (previous working day), open 5 days |
| Licensed-teacher subsidy | System Configuration → Payroll → Licensed Teacher Subsidy | the year's amount, if it applies |
| Holiday calendar | System Configuration → Holidays | 2026 and 2027, plus proclaimed days |
| Super Admin account | Admin & HR Accounts | real email, can sign in |

Then create the real people, in this order: Admins (one per branch) and HR
(Super Admin), employees and accountants (HR → Employees, with RFID card
numbers, salary, government IDs and, for licensed teachers, the PRC fields).

## 3. Environment variables on the host

Set these in Vercel → Project → Settings → Environment Variables, scope
**Production** (details in [.env.example](../.env.example)):

| Variable | Value comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL (bare `https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page, anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, service_role / secret key (mark **Sensitive**) |
| `SESSION_SECRET` | a new random value for production, not the one in your `.env.local` |
| `GMAIL_USER` | the school's sending Gmail / Workspace address |
| `GMAIL_APP_PASSWORD` | an App Password for that account (mark **Sensitive**) |
| `MAIL_FROM_NAME` | optional, e.g. `SACS Payroll` |

Do **not** set on the host: `USE_MAILTM`, any `SEED_*_PASSWORD`,
`SEED_EMPLOYEE_*`, `SEED_ACCOUNTANT_*`. Set `SEED_SUPER_ADMIN_USERNAME` +
`SEED_SUPER_ADMIN_EMAIL` (and the Admin / HR pairs) only if the school wants a
username shortcut at sign-in.

## 4. Deploy (Vercel)

1. Merge the release branch into `ehdd` and tag it: `git tag v1.0.0 && git push --tags`.
2. Vercel → Add New → Project → import the GitHub repo. Framework: Next.js
   (auto). Production branch: `ehdd`.
3. Settings → Functions → **Function Region: Mumbai (bom1)**, next to the
   database (ap-south-1); every API call talks to it several times.
4. Add the variables from section 3, then **Deploy**.
5. Settings → Domains → add e.g. `payroll.<school-domain>`; create the DNS
   record Vercel shows (CNAME `cname.vercel-dns.com`, or A `76.76.21.21` for
   an apex). HTTPS certificates are issued automatically; the app already
   sends HSTS in production.
6. Supabase → Authentication → URL Configuration: **Site URL** =
   `https://payroll.<school-domain>`. Remove `localhost` and any old
   `/reset-password` entries from Redirect URLs: the app's codes are emailed,
   it uses no Supabase redirect links.
7. Gmail: send one test code (sign in) and check it is not in Spam. If it is,
   mark it "Not spam" for each staff inbox the first time.

## 5. Smoke test (first hour)

- [ ] `https://payroll.<school-domain>/login` loads with the seal; padlock shown.
- [ ] Super Admin signs in: password → emailed code (arrives within a minute) → dashboard.
- [ ] Wrong code 5 times → asks for a new code. Resend is refused for 60 seconds.
- [ ] Sign out → back to sign-in; the browser Back button does not reopen the portal.
- [ ] One Admin, one HR, one Accountant, one Employee each sign in and see only their own menu.
- [ ] An Admin sees only its branch's employees and attendance.
- [ ] RFID terminal at one branch: unlock, tap a real card → green; tap again at once → green, no change; tap 5+ minutes later → Time Out recorded.
- [ ] Unplug the network, tap → amber "saved"; reconnect → the count clears and the tap shows "(sent late)" in View Taps.
- [ ] Accountant opens Process Payroll for October 1–15, 2026: the banner shows "Payslip generation on Oct 15, 2026".
- [ ] Super Admin → Audit & Monitoring shows the sign-ins above.
- [ ] Vercel → Logs: no red errors.

## 6. Rollback

- **App:** Vercel → Deployments → the last good deployment → ⋯ →
  **Promote to Production** (instant, no rebuild). Or `git revert` the bad
  commit and push.
- **Database:** migrations only move forward. To undo data or schema damage:
  Pro → Database → Backups → Restore (the project is offline meanwhile), or
  restore your own dump into a new project and re-enter the PII key (section 1).
- Before any later migration: back up first, test it on the local replay.

## 7. RFID: per-branch hardware and network checklist

Do this at each of the 4 branches:

- [ ] **Reader**: USB RFID reader in keyboard (HID) mode, same frequency as the
      cards (125 kHz EM or 13.56 MHz Mifare), set to type the card number in
      **decimal** followed by **Enter**. Test in Notepad: one tap = one line of digits.
- [ ] **Kiosk device**: PC or tablet with current Chrome or Edge, screen at
      least 1024 × 768, on a UPS. Power and sleep settings: never sleep, never
      turn off the screen.
- [ ] **Clock**: set to update automatically. Offline taps carry the device's
      time; a clock more than 2 minutes fast is refused.
- [ ] **Browser**: a normal (not private / incognito) window, its own browser
      profile, no "clear data on exit". Saved taps live in that browser's
      storage until they are sent.
- [ ] **Kiosk mode** (optional): `msedge --kiosk https://payroll.<school-domain>/rfid-terminal --edge-kiosk-type=fullscreen`.
- [ ] **Network**: wired or strong Wi-Fi; outbound HTTPS to the payroll domain
      allowed; a backup (mobile hotspot) for long outages. Taps made offline
      are accepted for **24 hours**, then refused.
- [ ] **Daily**: the branch Admin unlocks the terminal each morning (the kiosk
      session lasts 16 hours) and checks "taps waiting to send" is not stuck.
- [ ] **Cards**: every employee's card number entered in HR → Employees;
      one test card per branch.

## 8. Tests only a person can do

| What | How |
|---|---|
| Real phones | On an Android and an iPhone: sign in, open each portal page, rotate the phone, open a dialog, download a payslip PDF. Look for text cut off, buttons hard to tap, tables that cannot scroll sideways. |
| Gmail codes | Sign in from a new browser for each role; time how long the code takes; check Spam; try Forgot Password and Change Password. |
| RFID at each branch | The section 7 checks, then the RFID items of section 5 with a real card. |
| Printing | Accountant → a payslip → Print, and Download PDF; Payroll Reports → Payroll Sheet (School Format) in **landscape** on the school printer. Check nothing is cut at the page edge. |
| Kiosk screen | Leave the terminal unlocked for a full school day; check it stays signed in and focused on the card field. |

## 9. Credentials and recovery

- Keep in the school's password manager (two people with access): Supabase
  login, Vercel login, GitHub login, the Gmail account + its App Password,
  the database password, `SESSION_SECRET`, and the PII key (section 1).
- Have **two** Super Admin accounts with real emails, so one lost mailbox
  does not lock the school out.
- **Super Admin forgot the password:** Forgot password on the sign-in page
  (code to their email).
- **Super Admin lost the mailbox:** the other Super Admin edits the email in
  Admin & HR Accounts. If there is no other: Supabase → Authentication →
  Users → that user → update the email, then the profile email to match.
- **Locked out after too many attempts:** wait 15 minutes, or a Super Admin
  can sign in from another network.
- **Rotating secrets:** a new `SESSION_SECRET` signs everyone out (fine
  after hours). A new service-role key must be updated in Vercel and
  redeployed. A new Gmail App Password: update `GMAIL_APP_PASSWORD`, redeploy.

## 10. Monitoring to add (recommended)

- **Error alerts:** Sentry (`@sentry/nextjs`, free tier) or a Vercel log
  drain, so a failing payroll run emails someone. Today errors are only in
  Vercel's logs, which keep a short history.
- **Uptime:** a free monitor (e.g. UptimeRobot) on `/login` every 5 minutes.
- **Nightly jobs:** in the SQL Editor,
  `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;`
  once a week.
- **Gmail limit:** a personal Gmail sends to about 500 recipients a day
  (Workspace about 2,000). Watch it if every employee signs in daily.
