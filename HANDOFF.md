# SACS Payroll — Handoff & Setup Guide

How to stand this project up on a **new GitHub repo, new Supabase project, and
new Vercel deployment**. Written for someone who has never seen the codebase.

Nothing in the repository is tied to any particular Supabase project — every
connection value is read from environment variables, and the full database
schema is reproducible from `supabase/migrations/`.

---

## 0. Before you hand the project over

> [!IMPORTANT]
> **The outgoing owner must rotate the Supabase keys, and must not share
> `.env.local` with anyone.**

`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security completely — it can
read and modify every payroll record, for every branch, with no permission
check. It is not a password that can be scoped down; anyone holding it owns the
data.

The incoming owner should create **their own** Supabase project and generate
their own keys, rather than inheriting existing ones. `.env.local` is
gitignored on purpose and should never be emailed, committed, or pasted into a
chat.

---

## 1. Prerequisites

| Tool | Notes |
|---|---|
| Node.js 20+ | Developed against Node 24. No `engines` field is pinned. |
| npm | Lockfile is `package-lock.json` — use `npm ci`, not `yarn`/`pnpm`. |
| A Supabase account | Free tier is enough to run it. |
| A Vercel account | Only needed for deployment, not local work. |

---

## 2. Create the Supabase project

1. Create a new project at [supabase.com](https://supabase.com). Save the
   database password somewhere safe.
2. Open **SQL Editor** and run **every** file in `supabase/migrations/` **in
   filename order**. The names sort chronologically, so alphabetical order is
   the correct order — start with `20260401010000_backfill_core_schema.sql` and work
   through to the last file in the directory.

   > [!IMPORTANT]
   > Run the whole directory, not up to some named file. This step used to say
   > "finish with `20260903010000_rbac_branch_scoping.sql`", which is a third of the
   > way through the list — following it literally produced a database missing
   > the transfer-request tables, the RFID and payroll indexes, and every later
   > constraint. There is no stopping point; the last file is whichever sorts
   > last today.
3. Go to **Settings → API** and copy these three values:
   - Project URL
   - `anon` / publishable key
   - `service_role` / secret key

There is no `supabase/config.toml`, so the Supabase CLI is not wired up.
Migrations are applied by hand through the dashboard. If you prefer
`supabase db push`, run `supabase init` and link the project yourself.

### Which tables the migrations create

`profiles`, `attendance_logs`, `audit_logs`, `payroll_records`,
`payroll_entries`, `leave_requests`, `branches`,
`employee_branch_assignments`, `transfer_requests`, `system_config`,
`role_permissions`, `attendance_holidays`, `attendance_corrections`,
`attendance_overtime_approvals`, `payroll_rate_configs`, `payroll_deductions`,
`payroll_incentives`, `payroll_tax_brackets`, `payroll_contribution_amounts`,
`payroll_monthly_incentives`, `payroll_thirteenth_month`,
`payroll_cash_advances`, plus the read-only view `employee_info_view`.

That covers every table the application queries. If a page errors with
"relation does not exist", a migration was skipped.

`salary_approvals` was listed here until it was dropped by
`20260917020000_drop_salary_approvals.sql`; no code references it any more.

---

## 2a. Emailed codes: Gmail (Nodemailer) and mail.tm

Sign-in, **Forgot Password** and **Change Password** for **every role**
(Super Admin, Admin, HR, Accountant, Employee; `src/lib/auth/otp-policy.js`)
use the app's own 6-digit code
(`src/lib/auth/email-otp.js`), emailed through Gmail SMTP with Nodemailer
(`src/lib/mail/gmail.js`, template `src/lib/mail/otp-email.js`). Only an
HMAC of the code is stored, in `public.auth_email_otps`
(`20261007020000_email_otp_codes.sql`). The database enforces, under a row
lock: 5-minute expiry, single use, 5 wrong codes then a new code is needed,
60 seconds between sends. Each flow has its own code (a sign-in code cannot
reset a password). Supabase Auth no longer sends any email for this app.

> [!IMPORTANT]
> **Every account needs a real, reachable email address.** The code goes to
> the address on the account; an account whose address cannot receive mail
> (for example a seeded `@example.com` address) cannot sign in. Fix every
> Super Admin, Admin and HR address before deploying.

1. On the Google account that sends the mail, turn on **2-Step Verification**,
   then create an **App password** (Google Account → Security → App
   passwords). Put the address in `GMAIL_USER` and the 16-character App
   password in `GMAIL_APP_PASSWORD`. Never the account's real password.
2. Gmail limits a personal account to about 500 recipients a day (Google
   Workspace: about 2,000). Enough for staff sign-ins; check it if every
   employee signs in several times a day.
3. The old Supabase setup (custom SMTP with Brevo, the "Magic link or OTP"
   template, Email OTP Length) is no longer used and can be left as it is.

**Testing delivery without a real inbox (development only).** Set
`USE_MAILTM=true` in `.env.local`, run `npm run mailtm -- create`, and set a
TEST account's email (any role) to the printed address. An inbox made on
mail.tm's own website is added with `npm run mailtm -- add <address> <password>`.
The five seeded accounts use mail.tm inboxes (`SEED_*_EMAIL`); real staff
accounts use their own Gmail. Sign in as
that account: the code screen shows **Read code from test inbox (mail.tm, dev
only)**, and `npm run mailtm -- otp <address>` prints the code in a terminal.
`src/lib/mail/mailtm.service.mjs` and `/api/dev/mailtm` are off whenever
`NODE_ENV=production`, whatever `USE_MAILTM` says.

**The sign-in screen and every portal** (`/login`, `/super-admin`, `/admin`,
`/hr`, `/accountant`, `/employee`, `/rfid-terminal`) are React with shadcn/ui
and Tailwind CSS v4 (`src/app/`, `src/components/ui/`, theme in
`src/styles/ui.css`, light and dark). The old HTML/JS portals
(`public/legacy/`) were retired on 2026-10-10; git tag
`before-legacy-removal` is the last commit that has them.

---

## 2b. Attendance status engine and the nightly job

`20260926010000_attendance_status_engine.sql` makes the database compute every
attendance status (On Time, Early Bird, Late, Undertime, Half Day, Absent,
Incomplete, Pending Correction, Corrected) from each branch's schedule in
System Configuration. `20260926020000_payroll_rate_configs.sql` adds the
effective-dated payroll rates (Super Admin → System Configuration → Payroll
Rates) and the per-line deduction/incentive tables. Payroll refuses to process
until both are applied, and says so on the Process Payroll screen.

The nightly job flags missed tap-outs as Incomplete and writes Absent records
for working days with no tap and no approved leave. It is a `pg_cron` job
(`attendance-nightly-close`, 00:05 Asia/Manila) created by
`20260926030000_schedule_attendance_nightly.sql`, which calls the database
function `attendance_close_days` directly, so no key is stored in the
database. Running the migrations sets it up; nothing else to schedule.

The `attendance-nightly` Edge Function does the same on demand (for example
to re-close a range of days). Deploy it with:

```bash
supabase functions deploy attendance-nightly
```

and call it with the service-role key as the Bearer token, optionally with
`{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`. The payroll and attendance
screens also run `attendance_close_days` for the days they show, so a missed
night delays the Incomplete queue but never produces a wrong payroll.

Absences are now recorded for every active Employee/Accountant who does not
tap on a working day (weekends and the holidays in `attendance_holidays` are
skipped). Super Admin → System Configuration → **Holidays** manages them
(`/api/admin/holidays`). Each year's holidays fixed by law plus Holy Week
(from Easter) and National Heroes Day are generated by
`attendance_seed_holidays(year)`: a pg_cron job (`holiday-calendar-next-year`)
runs it every December 1 for the next year, and **Generate Year** runs it on
demand. Add the proclaimed days (Eid'l Fitr, Eid'l Adha, Chinese New Year,
All Souls' Day, Christmas Eve, declared days) by hand when announced.

**Suspensions** (`20261007010000_holiday_calendar.sql`): HR → Attendance
Monitoring → Suspensions (or Super Admin) declares a typhoon / LGU day, even
the same morning. A whole-day suspension is a day off with no premium; a
morning / afternoon one keeps the day a working day with the schedule cut
at the given time (leaving at the cutoff is not undertime; an absence costs
half a day). A day with no tap on a holiday or whole-day suspension reads
**Holiday**, not Absent; adding one after the day recomputes that day's
records (`attendance_apply_holiday`). Payroll never deducts an Absent on a
holiday, and each payslip, its PDF and Accountant → Payroll Reports →
**Holiday Work** name every holiday worked with its hours and premium.

**RFID terminal.** Unlocking the terminal starts its own kiosk session
(`src/lib/auth/kiosk-session.js`): 16 hours, used only for taps, not ended by
the Admin signing in elsewhere, ended by Exit Terminal or by archiving /
demoting the account. Taps that cannot reach the server are kept on the
terminal and sent later with their tap time (accepted up to a day late). A
second tap within 5 minutes of one already recorded is ignored, so it can
never become a 0-hour Time Out.

---

## 2c. Payroll rules from October 1, 2026, and overtime

`20260926090000_payroll_legal_rules_and_atomic_commit.sql` switches pay
periods starting on or after **2026-10-01** to the legal tables
(`src/lib/payroll/statutory.js`): SSS by monthly salary credit, PhilHealth
within its floor and ceiling, Pag-IBIG up to the maximum fund salary, BIR
semi-monthly withholding tax, and a daily rate of monthly salary × 12 ÷ 261.
Earlier periods keep the flat-% rules they were paid under. Every percentage
and limit is an effective-dated rate in Super Admin → Payroll Rates; check them
against the current SSS, PhilHealth, Pag-IBIG and BIR circulars.

Overtime is paid only for minutes HR or an Administrator approves in the
Attendance board's **Overtime** tab (days at least 30 minutes past the end of
shift); work on a date in `attendance_holidays` earns the holiday premium.
Payslips are written all-or-nothing by the `payroll_commit_entries` database
function.

### Semi-monthly payroll (from October 1, 2026)

`20261003010000_semi_monthly_payroll.sql` and `src/lib/payroll/semi-monthly.js`:

- **1st half (1–15):** monthly salary ÷ 2, nothing deducted.
- **2nd half (16–end):** settles the whole month: absences and Leave Without
  Pay at the daily rate (monthly × 12 ÷ Working days per year; 31 or less
  means days per month), late / undertime / half day, approved leave,
  incentives and overload hours (Accountant → Incentives & Overload),
  overtime and holiday pay, the month's SSS / PhilHealth / Pag-IBIG once,
  and withholding tax once from the **monthly** table. It pays the month's
  net less what the 1st half paid. A negative result is paid as 0 and carried
  into next month's 2nd half.
- **Attendance lock day** (Payroll Rates, seeded 28): the 2nd half counts
  attendance from the day after last month's lock to this month's. Leave and
  incentives dated or filed after the lock are paid next month.
- **Super Admin → System Configuration** also holds the Withholding Tax
  Table (Monthly), seeded with the BIR table, and per-employee Contribution
  Amounts. Both are saved as versions from an effective date.
- **13th month** (Accountant → 13th Month Pay): basic pay earned in the year
  (less Absent days and Leave Without Pay) ÷ 12, from Final payslips.
  Processed from December 1 and recorded once per employee.

### The school's payroll (two payslips a month) and the payroll sheet

`20261006010000_school_payroll_sheet.sql` (run after the semi-monthly file),
`src/lib/payroll/school-sheet.js` and `src/lib/payroll/cash-advance.js` set the
semi-monthly rule above to the school's own amounts:

- **1–15 payslip:** the full Rate (monthly ÷ 2). Nothing is deducted.
- **16–end payslip:** every deduction: days missed (Daily = monthly ÷ 24,
  i.e. Rate ÷ 12), SSS ₱400, Pag-IBIG ₱200 (no PhilHealth), withholding tax,
  cash advance installments; plus approved OT at 125%.
- **Which attendance:** the 16–end payslip deducts the attendance read up to
  the 15th (Attendance lock day = 15, Deduct days after the lock day next
  month = On). October 16–31 deducts October 1–15 (the first month starts on
  the 1st); November 16–30 deducts October 16 – November 15. The Payroll
  Sheet prints the attendance dates under the period.

| Sheet column (16–end) | Rule |
|---|---|
| Rate | Monthly salary ÷ 2 |
| Days / Reg. Hrs. | 12 − days missed from the 16th of last month to the 15th (Absent, Leave Without Pay, Half Day = ½); hours = days × 8 |
| Amount | Rate − Daily × days missed |
| OT / Rate / Amount | Approved OT hours × hourly × 125% |
| Cash Advance | One installment per month until repaid (Accountant → Cash Advances) |
| SSS / PhilHealth / Pag-IBIG | Fixed monthly amounts; per-employee amounts (0 = exempt) in Super Admin → Contribution Amounts |
| Late / Undertime | Off (`late_days_per_absent` = 0) unless the school sets a rule |
| Net Pay | Total Amount − Total Deduction |

All values are effective-dated rates in Super Admin → Payroll Rates, from
2026-10-01: **Contributions as fixed amounts** = On, **SSS / PhilHealth /
Pag-IBIG fixed amount** = 400 / 0 / 200, Working days per year = 24, Late days
per absence = 0, Attendance lock day = 15, Deduct days after the lock day
next month = On. **Pay each half on its own attendance** is Off (the school's
way); turning it On pays each half on its own attendance instead.

Cash advance repayments are read from Final payslips
(`payroll_entries.payroll.cash_advances`), so a Draft repays nothing and an
overridden payslip replaces its own repayment. An installment never pushes
net pay below zero; the rest stays on the balance.

**Accountant → Payroll Reports → Payroll Sheet (School Format)** prints the
sheet per branch (Days, Reg. Hrs., Rate, Amount, OT, Cash Advance,
contributions, totals row, signature column and the "Approved for payment"
block from Super Admin → Payroll Configuration). Print in landscape. Every
column is in centavos, so the columns always add up to the totals row.

Security settings (Super Admin → System Configuration → Security) are
enforced: Session Timeout is an idle timeout (8 hours after sign-in at most),
Max Login Attempts, Password Minimum Length and Force Password Expiry apply at
sign-in and password change. Also turn on **Authentication → Password security
→ Leaked password protection** in the Supabase dashboard.

---

## 3. Configure the environment

Copy `.env.example` to `.env.local` and fill it in.

```bash
cp .env.example .env.local
```

### Required

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL — **see the trap below** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key. Safe to expose to the browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key. Server-only — never send to the browser. |
| `SESSION_SECRET` | Signs the login session cookie. See below. |
| `GMAIL_USER` | Gmail address the code emails are sent from (section 2a). Server-only. |
| `GMAIL_APP_PASSWORD` | A Google **App password** for that account, not its real password. Server-only. |
| `MAIL_FROM_NAME` | Optional sender name (default "SACS Payroll"). |
| `USE_MAILTM` | Development only: `true` turns on the mail.tm test inbox reader. Ignored in production. Leave `false` in Vercel. |

`SEED_*` variables set the default account credentials created in step 4.
Change every seeded password before going anywhere near real data.

### ⚠️ Trap 1 — the Supabase URL must be the bare origin

The Supabase dashboard shows both a **Project URL** and a **REST endpoint**.
You want the Project URL.

```bash
# CORRECT
NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co

# WRONG — breaks all logins
NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co/rest/v1/
```

`supabase-js` appends its own service paths. Given the second form it builds
`/rest/v1/auth/v1/token`, and every login fails with
`{"error":"Invalid path specified in request URL"}`.

### ⚠️ Trap 2 — always set `SESSION_SECRET` explicitly

If `SESSION_SECRET` is unset, `src/lib/rbac/session.js` silently falls back to
`SUPABASE_SERVICE_ROLE_KEY`. That works, but couples the two: rotating the
Supabase key would invalidate every active session and sign all users out at
once. Set a dedicated random value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## 4. Install, seed, and run

```bash
npm ci                          # install exact locked dependencies
npm run supabase:check          # verify the connection works
npm run supabase:seed-users     # create the 5 role accounts
npm run dev                     # http://localhost:3000
```

`supabase:seed-users` creates one account per role — Super Admin, Admin, HR,
Accountant, Employee — using the `SEED_*` values from `.env.local`.

Confirm it worked by signing in and checking that each portal loads its own
sidebar. If login returns `Invalid path specified in request URL`, revisit
Trap 1.

---

## 5. Deploy to Vercel

1. Push the repo to the new GitHub remote, then import it in Vercel. The
   framework preset auto-detects as Next.js — no `vercel.json` is needed.
2. Add every variable from `.env.local` under
   **Settings → Environment Variables**, including `GMAIL_USER` and
   `GMAIL_APP_PASSWORD` (without them no code email can be sent, so
   sign-in stops at the code step for every role).
3. In Supabase, go to **Authentication → URL Configuration** and set the
   **Site URL** to the production domain. Password reset does not use
   redirect links (it is a 6-digit emailed code, section 2a), so the old
   `/reset-password` redirect URL can be removed.

`.env.local` is never deployed. Anything missing from the Vercel dashboard is
missing in production.

---

## 6. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Vitest — RBAC permission matrix tests |
| `npm run lint` | ESLint (`no-undef` is enabled) |
| `npm run supabase:check` | Connectivity check against the anon key |
| `npm run supabase:seed-users` | Create/refresh the five role accounts |
| `npm run supabase:purge-archived` | **Hard-deletes** archived employees — see below |
| `npm run mailtm -- create [address]|add <address> <password>|list|messages|otp|delete` | mail.tm test inboxes for checking code emails (development only, section 2a) |

> [!CAUTION]
> **Two scripts destroy data irreversibly. Neither asks for confirmation.**
>
> `node scripts/clean-reset.mjs` wipes the application tables and removes
> non-seed auth users. It is a development reset for a scratch project — never
> point it at anything holding real payroll records. It is deliberately left
> out of the npm scripts above.
>
> Its `SEED_EMAILS` list is what decides who survives: anything absent is
> treated as an extra account and hard-deleted, profile and auth user both.
> The list used to name only Admin, Accountant and Employee, so a reset also
> destroyed the **Super Admin and HR** accounts — taking out the highest
> privilege in the system along with the roles needed to recreate it. It now
> lists all five accounts `scripts/seed-auth-users.mjs` creates. Keep the two
> in step if you add a role.
>
> `npm run supabase:purge-archived` deletes archived employees' `profiles`
> rows and then calls `auth.admin.deleteUser()` on each one. This is a genuine
> hard delete, and it is the **one exception** to the archive-only rule the
> rest of the system enforces (see §7). Because payroll and attendance rows
> reference these accounts, purging can strip the identity behind historical
> records. Treat it as a maintenance tool requiring a deliberate decision and
> a fresh backup — not routine cleanup.

---

## 7. How authorization works

Read this before changing any API route.

Access control has two layers, both reading the same matrix in
`src/lib/rbac/permissions.js`:

1. **`src/proxy.js`** — runs before every request. Maps each `/api/**` path to
   a module and the HTTP verb to an action, then rejects the request if the
   caller's role lacks that permission. Coarse: answers only *"may this role
   touch this module at all"*. Unmapped `/api` paths **fail closed**, so a new
   route cannot ship unguarded by accident.

2. **`src/lib/rbac/guard.js`** — called inside a handler via
   `requirePermission()`. This is where **branch scoping and self-scoping**
   happen. The proxy cannot do these, because they depend on the request body
   or the rows involved.

Because the API routes hold the service-role key, they bypass RLS — so the
guard, not RLS, is what actually enforces the permission matrix on them. The
RLS policies in `20260903010000_rbac_branch_scoping.sql` are a second layer covering
any client that talks to Postgres directly.

### Rules when adding a route

- Add the path to `API_MODULES` in `src/proxy.js`, or it returns 403.
- Call `requirePermission()` in the handler if it touches per-user or
  per-branch data — the proxy alone does **not** scope anything.
- Never take the acting account from a query parameter or request body. Use
  `resolveTargetEmail()` / `resolveTargetUserId()` from the guard, which pin a
  self-scoped caller to their signed session cookie. Trusting the request is
  what previously let any employee read a colleague's payslip and rewrite their
  bank account number.
- "Delete" means **archive** everywhere in this system. Payroll and attendance
  history must stay referentially intact; no role gets a hard delete.
- Render stored text through React (JSX escapes it). Employee-typed values —
  a leave reason, a name, a branch label — reach HR and Super Admin screens,
  and putting them into `dangerouslySetInnerHTML` or an `innerHTML` string is
  how an employee ends up running script in a privileged session.

### Sign-in throttling

`src/lib/auth/login-throttle.js` caps failed attempts two ways: 5 per account
and 30 per client IP, each over a 15-minute window with a 15-minute lockout. A
successful sign-in clears the account counter but not the IP one, so a valid
login cannot reset the budget for an address working through a list of others.
Blocked attempts get `429` with `Retry-After` and `code: "too_many_attempts"`.

---

## 8. Known gaps

Honest list of what is not finished, for whoever picks this up:

- **`role_permissions` table is not what the API reads.** The live matrix is
  the hardcoded one in `src/lib/rbac/permissions.js`. The table is seeded and
  used by the SQL-side RLS helper `has_permission()`, and
  `tests/rbac-permissions.test.js` asserts the two stay in step — but making
  the API data-driven from it, as `SACS-Payroll-Permission-Matrix.md`
  describes, is still not done.
- **System Configuration is saved but not enforced.** Every field on the Super
  Admin's System Configuration screen is written to `system_config` and read
  back into its own form, and nothing else reads that table. The real values
  are fixed in code: the session lasts 8 hours (`src/lib/rbac/session.js`),
  sign-in allows 5 attempts per account (`src/lib/auth/login-throttle.js`),
  dates render in Asia/Manila in each route, and payroll takes SSS/PhilHealth/
  Pag-IBIG from the amounts entered on the payslip rather than the configured
  rates (`src/app/api/accountant/payroll/route.js`). The absence rate of ₱550/day
  and the 3-lates-equals-1-absence rule are hardcoded there too, with no config
  field at all. The screen now says so per section; wiring it up is outstanding.
- **No integration tests against live routes.** The suite covers the permission
  matrix, the proxy, and login throttling as pure functions; nothing exercises
  a handler against a real Supabase instance, which is why route-level bugs
  have slipped through before.
- **Login throttling is per server instance.** `src/lib/auth/login-throttle.js`
  holds its counters in memory, so on a multi-instance deployment an attacker
  spread across instances gets proportionally more attempts. Moving the
  counters into Postgres would close that; the module's exports can stay as
  they are.
- **`listUsersCached` caps at 1000 auth users** (`src/lib/auth/users-cache.js`).
  Past that the list silently truncates rather than erroring. Fine for one
  school, wrong for a larger tenant — it needs pagination before then.

### Closed since this list was written

- ~~Most API routes rely on the proxy alone / HR, accountant and dashboard
  routes are not branch-scoped in the handler.~~ No longer true: every route
  under `hr/*`, `accountant/*` and the dashboards calls `requirePermission()`
  and scopes its queries. Verified route by route.
- ~~No rate limiting on login.~~ Added — see `src/lib/auth/login-throttle.js`
  and §7 below.

---

## 9. Further reading

| File | Contents |
|---|---|
| `README.md` | Short project overview |
| `RULES.md` | Working agreement for AI-assisted edits |
| `SACS-Payroll-Permission-Matrix.md` | The authoritative role/permission matrix |
| `src/lib/rbac/permissions.js` | That matrix as executable code |
