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
`role_permissions`, plus the read-only view `employee_info_view`.

That covers every table the application queries. If a page errors with
"relation does not exist", a migration was skipped.

`salary_approvals` was listed here until it was dropped by
`20260917020000_drop_salary_approvals.sql`; no code references it any more.

---

## 2a. Email OTP: SMTP, template and expiry

Sign-in (Employee / Accountant), **Forgot Password** and **Change Password**
(Employee / Accountant) all use Supabase Auth's own email OTP
(`signInWithOtp` / `verifyOtp`). Supabase generates the 6-digit code, stores
only its hash, expires it and consumes it on first use; Brevo only delivers
the email. The app adds the rest in `src/lib/auth/otp-throttle.js` and
`src/lib/auth/password-otp.js`: 5 wrong codes lock the flow until a new OTP
is requested, 60 seconds between sends, and a 5-minute window per code.
There is no Edge Function to deploy.

1. **Authentication → Emails → SMTP Settings**: turn on custom SMTP with the
   Brevo SMTP relay (`smtp-relay.brevo.com`, port 587, your Brevo SMTP login
   and SMTP key, a sender address verified in Brevo).
2. **Authentication → Emails → Templates → Magic link or OTP**: the body must
   show the code with `{{ .Token }}`. The default template sends a link
   instead. Example body:
   `<p>Your SACS Payroll code is <strong>{{ .Token }}</strong>. It expires in 5 minutes.</p>`
3. **Authentication → Providers → Email**: set **Email OTP Length** to 6 and
   **Email OTP Expiration** to 300 seconds (5 minutes). This also applies to
   the sign-in code.
4. **Authentication → Rate Limits**: raise **Emails sent per hour** to suit the
   staff count. Supabase also allows one email per address every 60 seconds.

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
| `APP_URL` | No longer used. Password reset is OTP-based (see section 2a), so no reset links are built. |

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
   **Settings → Environment Variables**. (`APP_URL` and `APP_URL_ALLOWLIST`
   are no longer read and can be left out.)
3. In Supabase, go to **Authentication → URL Configuration** and set the
   **Site URL** to the production domain. Password reset no longer uses
   redirect links (it is a 6-digit OTP, section 2a), so the old
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
- Anything that renders stored text into the legacy portals must pass it
  through `escapeHtml()` (defined in `public/legacy/js/app.js`). Employee-typed
  values — a leave reason, a name, a branch label — reach HR and Super Admin
  screens, and interpolating them raw into `innerHTML` is how an employee ends
  up running script in a privileged session. For a value going into an
  `onclick`, escaping is **not** enough: HTML entity decoding happens before
  the JS is parsed, so pass it by lookup key instead (see `window._hrProofUrls`
  in `hr.js`).

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
