# SACS Payroll (Next.js)

Payroll, RFID attendance, leave and HR records for Shepherd Angels Christian
School's branches. Next.js App Router with shadcn/ui and Tailwind CSS v4 on the
front, Supabase (Postgres, Auth) behind it. Roles: Super Admin, Admin, HR,
Accountant, Employee.

Nothing in the repository is tied to a particular Supabase project: every
connection value comes from environment variables, and the whole schema is
rebuilt from `supabase/migrations/`.

> [!IMPORTANT]
> `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security: anyone holding it
> can read and change every payroll record in every branch. Never commit,
> email or paste `.env.local`. A new owner should create their own Supabase
> project and keys rather than inherit existing ones.

## Prerequisites

| Tool | Notes |
|---|---|
| Node.js 20+ | Developed on Node 24. |
| npm | Use `npm ci` (lockfile is `package-lock.json`). |
| Supabase account | The free tier is enough. |
| Docker Desktop + Supabase CLI (`npx supabase`) | For testing migrations on a local copy before they touch a real project. |
| Vercel account | Deployment only. |

## Set up a new environment

1. **Supabase project.** Create one and save its database password. From the
   repo root run `npx supabase init` (once; answer N to the editor prompts),
   `npx supabase link --project-ref <ref>`, then `npx supabase db push`. On an
   empty project that applies every file in `supabase/migrations/` in order.
   Copy the Project URL, the anon key and the service_role key from
   **Settings → API**.
2. **Environment.** `cp .env.example .env.local` and fill it in;
   `.env.example` notes every variable. Required: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SESSION_SECRET`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`. The `SEED_*` values
   are the default accounts created in step 3; change those passwords before
   real data goes in.
3. **Install, seed, run.**
   ```bash
   npm ci
   npm run supabase:check        # connection works
   npm run supabase:seed-users   # one account per role
   npm run dev                   # http://localhost:3000
   ```
   Sign in as each role and check its portal loads its own sidebar.

### Two traps

- **Use the bare Project URL**, `https://<ref>.supabase.co`, not the REST
  endpoint (`.../rest/v1/`). supabase-js adds its own paths, and the REST form
  fails every login with `Invalid path specified in request URL`.
- **Always set `SESSION_SECRET`.** Outside production it falls back to the
  service-role key, so rotating that key would sign everyone out. Generate
  one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## Emailed codes (Gmail and mail.tm)

Sign-in, Forgot Password and Change Password for every role use the app's own
6-digit code (`src/lib/auth/email-otp.js`), sent through Gmail SMTP with
Nodemailer (`src/lib/mail/gmail.js`). Only an HMAC of each code is stored, in
`auth_email_otps`; the database enforces a 5-minute expiry, single use, 5 wrong
tries and 60 seconds between sends. Supabase Auth sends no email for this app.

- **Every account needs a reachable email address**: an account that cannot
  receive the code cannot sign in.
- `GMAIL_APP_PASSWORD` is a Google **App password** (2-Step Verification on,
  then Google Account → Security → App passwords), never the account's real
  password. A personal Gmail sends to about 500 recipients a day.
- **Testing without a real inbox (development only):** set `USE_MAILTM=true`,
  run `npm run mailtm -- create`, and give a test account the printed address.
  The code screen then offers *Read code from test inbox*, or
  `npm run mailtm -- otp <address>` prints it. mail.tm is off whenever
  `NODE_ENV=production`.

## Deploy to Vercel

Vercel Hobby is for **testing only** (non-commercial). Production runs on a free Oracle Cloud VM: see [docs/hosting.md](docs/hosting.md).

1. Import the GitHub repo in Vercel (Next.js is auto-detected).
2. Add every variable from `.env.local` under Settings → Environment
   Variables. Without `GMAIL_USER` / `GMAIL_APP_PASSWORD` no one can get past
   the code step. Leave `USE_MAILTM` unset or `false`.
3. In Supabase → Authentication → URL Configuration, set the Site URL to the
   production domain.

## Attendance and payroll

- **RFID terminal** (`/rfid-terminal`, Admin and Super Admin): unlocking it
  starts its own 16-hour kiosk session (`src/lib/auth/kiosk-session.js`) used
  only for taps. The first tap of the day is Time In and the last is Time Out.
  A tap within 5 minutes of the previous one is ignored. Taps that cannot reach
  the server wait on the terminal and are sent with their tap time, up to a
  day late, marked "(sent late)".
- **Nightly close:** a pg_cron job (`attendance-nightly-close`, 00:05 Manila)
  calls `attendance_close_days`: missed tap-outs become Incomplete, and working
  days with no tap and no approved leave become Absent. The
  `attendance-nightly` Edge Function does the same on demand.
- **Holidays and suspensions:** Super Admin → System Configuration → Holidays;
  HR declares suspensions. A pg_cron job seeds next year's fixed holidays every
  December 1.
- **Payroll rules** (semi-monthly, payslip schedule, loans, AWOL hold,
  licensed-teacher subsidy) with worked examples:
  [docs/payroll-schedule-loans-awol.md](docs/payroll-schedule-loans-awol.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Vitest suite |
| `npm run lint` | ESLint (`no-undef` on) |
| `npm run supabase:check` | Connectivity check |
| `npm run supabase:seed-users` | Create or refresh the five role accounts |
| `npm run supabase:purge-archived` | **Hard-deletes** archived employees (see below) |
| `npm run mailtm -- create\|add\|list\|messages\|otp\|delete` | mail.tm test inboxes (development only) |

> [!CAUTION]
> **Two scripts destroy data irreversibly.**
>
> - `node scripts/clean-reset.mjs` wipes the application tables and every
>   non-seed account. It refuses the live project and `NODE_ENV=production`
>   (`scripts/clean-reset-guard.mjs`); anywhere else you must type
>   `RESET <project ref>` in a terminal. Its `SEED_EMAILS` list decides which
>   accounts survive, so keep it in step with `scripts/seed-auth-users.mjs`.
> - `npm run supabase:purge-archived` hard-deletes archived employees' profiles
>   and auth users: the one exception to the archive-only rule. Payroll and
>   attendance rows point at those accounts, so take a backup and decide
>   deliberately.

## How authorization works

Read this before changing any API route. Two layers read the same matrix,
`src/lib/rbac/permissions.js` (the readable version is
`SACS-Payroll-Permission-Matrix.md`):

1. **`src/proxy.js`** runs before every request: it maps each `/api/**` path
   to a module and the HTTP verb to an action, and rejects the call if the
   role lacks it. An unmapped `/api` path fails closed (403).
2. **`src/lib/rbac/guard.js`** (`requirePermission()` inside each handler)
   does the branch and self scoping that depends on the rows involved.

The routes hold the service-role key, so they bypass RLS; the guard is what
enforces the matrix there. RLS is the second layer for any direct client.

When adding a route:

- Add the path to `API_MODULES` in `src/proxy.js`, or it returns 403.
- Call `requirePermission()` in the handler if it touches per-user or
  per-branch data; the proxy alone scopes nothing.
- Never take the acting account from the query or body. Use the guard's
  `resolveTargetEmail()` / `resolveTargetUserId()`, which pin a self-scoped
  caller to their session.
- "Delete" means **archive**: payroll and attendance history must stay
  intact, and no role gets a hard delete.
- Render stored text through React (JSX escapes it). Employee-typed values
  reach HR and Super Admin screens, so never put them in
  `dangerouslySetInnerHTML` or an `innerHTML` string.

Sign-in is throttled per account (5) and per client address (30) over 15
minutes, in memory and in Postgres (`auth_throttle`) so every server instance
shares one budget. Blocked attempts get `429` with `Retry-After`.

## Known gaps

- **The API does not read `role_permissions`.** The live matrix is the one in
  `src/lib/rbac/permissions.js`; the table feeds only the SQL-side RLS helper
  `has_permission()`, and `tests/rbac-permissions.test.js` keeps the two in
  step.
- **No tests against a real Supabase instance.** Route tests run the real
  handlers on an in-memory fake database, so a mismatch with the live schema
  only shows up in the local replay or on the live project.

## Project structure

- `src/app` - App Router pages (sign-in, the five role portals, the RFID terminal) and API routes
- `src/components` - shared portal components and shadcn/ui primitives
- `src/lib` - payroll, attendance, auth and RBAC logic shared by the routes
- `src/lib/supabase` - Supabase server and service clients
- `supabase/migrations` - the schema, in order; `supabase/functions` - Edge Functions
- `public/brand` - the school seal images
- `docs/` - payroll design and worked examples, the local migration replay

## Supabase migrations

Test every new file on a local replay first (Docker + Supabase CLI,
[docs/local-migration-replay.md](docs/local-migration-replay.md)), then apply
it to the live project. The same doc has the one-time
`supabase migration repair` that lines the live history up with the file
names.

The schema has 39 tables and 2 read-only views:

- **Accounts and branches:** `profiles`, `branches`, `employee_branch_assignments`, `transfer_requests`, `role_permissions`, `system_config`
- **Attendance:** `attendance_logs`, `attendance_taps`, `attendance_logs_history`, `attendance_corrections`, `attendance_overtime_approvals`, `attendance_holidays`, `attendance_blocked_taps`
- **Leave and HR:** `leave_requests`, `employee_awol_cases`, `employee_status_changes`, `employee_license_documents`, `employee_license_changes`, `employee_license_alerts`
- **Payroll:** `payroll_entries`, `payroll_records`, `payroll_deductions`, `payroll_incentives`, `payroll_rate_configs`, `payroll_tax_brackets`, `payroll_contribution_amounts`, `payroll_monthly_incentives`, `payroll_thirteenth_month`, `payroll_schedule_settings`, `payroll_setting_changes`, `payroll_loans`, `payroll_loan_payments`, `payroll_subsidy_settings`, `payroll_subsidy_balances`, `payroll_subsidy_adjustments`, `payroll_cash_advances` (read-only history)
- **System:** `audit_logs`, `auth_throttle`, `auth_email_otps`
- **Views:** `employee_info_view`, `payroll_exempt_benefits_paid`

## History

- The old HTML/JS portals (`public/legacy`, and the `?classic=1` route that opened them) were retired on 2026-10-10. Git tag `before-legacy-removal` is the last commit that has them; code comments that say a function was "ported from public/legacy/js/..." refer to files at that tag.
- The `/api/legacy-auth/*` routes are the current sign-in and session API; only the name is historical.

## Further reading

| File | Contents |
|---|---|
| `RULES.md` | Working agreement for AI-assisted edits |
| `SACS-Payroll-Permission-Matrix.md` | The role and permission matrix |
| `docs/payroll-schedule-loans-awol.md` | Payroll design, formulas and worked examples |
| `docs/local-migration-replay.md` | Testing migrations locally; repairing the migration history |
| `docs/hosting.md` | Free hosting options compared; moving to an Oracle Cloud VM step by step |
| `docs/backup-and-restore.md` | Free-plan limits, backups, restore test, keep-alive |
| `docs/monitoring.md` | Sentry error monitoring set-up |
| `docs/go-live.md` | Going live: backup, clearing test data, host variables, deploy, rollback, smoke test, RFID kits |
| `docs/super-admin-settings.md` | Payslip schedule, subsidy, rates, tax table, holidays, security |
| `docs/user-guide-outline.md` | Outline of the staff guide for each role |
| `scripts/go-live/clear-test-data.sql` | Clears test data while keeping settings (dry run by default) |
