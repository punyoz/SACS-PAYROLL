# End-to-end tests (Playwright)

The suite drives the whole system in a real browser against the **local**
Supabase stack and a local `next dev`. It never touches the live project:
`e2e/local-env.mjs` reads the local stack's keys from `supabase status`, sets
every variable the app reads (so nothing falls through to `.env.local`), and
refuses any URL that is not `127.0.0.1` / `localhost`.

## Run

1. Start Docker Desktop, then `npx supabase start`.
2. `npm run test:e2e`

By default it runs **headed and slowed down** (450 ms per action, 1440×900) so
you can watch it, with a banner at the bottom of the page naming each step
(`HR > Payroll Approval > click Approve`). Options (environment variables):

| Variable | Effect |
| --- | --- |
| `E2E_HEADLESS=1` | no visible browser |
| `E2E_SLOWMO=0` | full speed |
| `E2E_RESET=0` | keep the current local data (skip `supabase db reset`) |
| `E2E_PORT` | dev-server port (default 3100) |
| `E2E_REUSE_SERVER=1` | reuse a dev server already running on that port |

One spec: `npx playwright test e2e/specs/20-payroll-flow.spec.mjs`.

## What runs

Before the tests, `e2e/global-setup.mjs` resets the local database (all
migrations), then `e2e/seed-e2e.mjs` creates the test accounts through
`scripts/seed-auth-users.mjs` plus a second branch, a second Admin, three
employees, RFID cards and October attendance (`e2e/fixtures.sql`). The test
accounts are in `e2e/accounts.mjs` (local only).

| Spec | Covers |
| --- | --- |
| `10-access` | signed-out access, other roles' portals, forbidden APIs per role |
| `20-payroll-flow` | process → submit → HR rejects with reason → resubmit → approve → History → employee sees the payslip only after approval |
| `25-subsidy-flow` | subsidy settings, licensing a teacher, process → reject → resubmit → approve, Decision history |
| `30-leave-flow` | employee files, Admin recommends, HR approves, employee sees it |
| `40-awol-flow` | Admin files a no-show, HR confirms and closes the AWOL case |
| `50-hr-management` | transfers with endorsement, work schedules, Tenure Pay Protection, branch scoping |
| `60-rfid-flow` | terminal, card registration, taps, duplicate / deactivated / unknown cards |
| `70-incentives-late` | incentive after the cutoff is deferred (notice shown), late recorded at 0% |
| `80-layout-states` | every page at phone width in dark mode; loading and error states |
| `90-page-sweep` | every page and sub-tab: refresh and navigate-away-and-back keep the data; every search, filter, sort, pagination, dialog and export |

Every page is watched the whole time: a console error, uncaught exception,
crash or unexpected failed request fails the test (`e2e/support/monitor.mjs`).

## Output

Everything goes to `test-results/` (git-ignored):

- `test-results/html/index.html`: the report (`npx playwright show-report test-results/html`)
- `test-results/artifacts/<test>/`: `video.webm`, `trace.zip`
  (`npx playwright show-trace <file>`) and a screenshot on failure
- `test-results/screens/`: phone-width dark-mode screenshots of every page
- `test-results/issues.jsonl`: console errors, failed and slow requests per test
