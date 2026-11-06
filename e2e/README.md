# End-to-end tests (Playwright)

The suite drives the whole system in a real browser against the **local**
Supabase stack and a local `next dev`. It never touches the live project:
`e2e/local-env.mjs` reads the local stack's keys from `supabase status`, sets
every variable the app reads (so nothing falls through to `.env.local`), and
refuses any URL that is not `127.0.0.1` / `localhost`.

## Run

1. Start Docker Desktop, then `npx supabase start`.
2. `npm run test:e2e`

By default it runs **headed and slowed down** (500 ms per action, 1280×800,
one visible browser, one worker) so you can watch it, with a banner at the
bottom of the page naming each step (`HR > Payroll Approval > click Approve`).
The terminal narrates every step with a number (`[step 123] HR > ...`); a
console error, page error or failed request is printed in plain words with the
step number (`⚠ PROBLEM at step 123 ...`) and the browser pauses 3 seconds on
it; a failed test prints `✖ FAILED after step N` and pauses 3 seconds too.

Two projects run in order: **desktop** (every spec in `e2e/specs/`, 1280×800)
and then **mobile** (the key flows in `e2e/mobile/`, 390×844 with touch).
`--project=desktop` or `--project=mobile` runs one of them.

The live run as used for the full system check (2026-11-05), in PowerShell:

```powershell
$env:E2E_TIME_TRAVEL=1; $env:E2E_SLOWMO=500; npx playwright test
```

Options (environment variables):

| Variable | Effect |
| --- | --- |
| `E2E_HEADLESS=1` | no visible browser |
| `E2E_SLOWMO=0` | full speed |
| `E2E_RESET=0` | keep the current local data (skip `supabase db reset`) |
| `E2E_PORT` | dev-server port (default 3100) |
| `E2E_REUSE_SERVER=1` | reuse a dev server already running on that port |
| `E2E_TIME_TRAVEL=1` | lets specs move the server's "today" (holiday / rest-day taps, year rollover) |
| `E2E_PROBLEM_PAUSE` | ms to pause on a problem (default 3000 headed, 0 headless) |

One spec: `npx playwright test e2e/specs/20-payroll-flow.spec.mjs`.

## What runs

Before the tests, `e2e/global-setup.mjs` resets the local database (all
migrations), then `e2e/seed-e2e.mjs` creates the test accounts through
`scripts/seed-auth-users.mjs` plus a second branch, a second Admin, three
employees, RFID cards and October attendance (`e2e/fixtures.sql`). The test
accounts are in `e2e/accounts.mjs` (local only).

| Spec | Covers |
| --- | --- |
| `05-api-matrix` | every GET API route × every role and signed out (402 calls): allowed roles get an answer, the rest 401/403, never a 5xx (`test-results/api-matrix.json`) |
| `10-access` | signed-out access, other roles' portals, forbidden APIs per role |
| `12-login-accounts` | who may create whom (SA: SA/Admin/HR; HR: Accountant/Employee; Admin: none), duplicates and bad input, first sign-in password change, each new account sees only its portal, a new Admin's branch kiosk, wrong password / code, expired code, lock-outs, logout (cookie cannot be replayed), expired and tampered sessions, password reset and change, archive / restore |
| `20-payroll-flow` | process → submit → HR rejects with reason → resubmit → approve → History → employee sees the payslip only after approval |
| `25-subsidy-flow` | subsidy settings, licensing a teacher, process → reject → resubmit → approve, Decision history |
| `30-leave-flow` | employee files, Admin recommends, HR approves, employee sees it |
| `33-leave-extra` | no proof, without pay, overlapping dates refused, HR rejects + the employee's notice, approved leave in the payroll preview (with pay vs without pay, each day once) |
| `40-awol-flow` | Admin files a no-show, HR confirms and closes the AWOL case |
| `50-hr-management` | transfers with endorsement, work schedules, Tenure Pay Protection, branch scoping |
| `60-rfid-flow` | terminal, card registration, taps, duplicate / deactivated / unknown cards |
| `62-rfid-edge` | a late time in (offline kiosk tap) and time out: late / undertime minutes from the shift; HR Attendance, Accountant View Attendance, timesheet; nightly close marks a missed day Absent; holiday and rest-day taps (time travel); a deactivated employee's card |
| `70-incentives-late` | incentive after the cutoff is deferred (notice shown), late recorded at 0% |
| `80-layout-states` | every page at phone width in dark mode; loading and error states |
| `92-gaps` | 13th Month Pay (December-only processing), branch isolation by direct API call, Admin → HR branch request (reject with reason / approve), theme toggle, sidebar collapse, Refresh, bell and account menu for every role |
| `mobile/m1-key-flows` | (phone project) sign-in, every sidebar page from the phone menu without sideways scrolling, leave filed and rejected from phones, payslip, Process Payroll, Payroll Approval, RFID kiosk |
| `90-page-sweep` | every page and sub-tab: refresh and navigate-away-and-back keep the data; every search, filter, sort, pagination, dialog and export |
| `95-scenarios` | real-world scenarios (SCENARIOS.md): concurrent edits, duplicate people, CSV onboarding, separation, payroll corrections, a forgotten card, a far-early tap, role change, audit search, a new branch, database size |

Every page is watched the whole time: a console error, uncaught exception,
crash or unexpected failed request fails the test (`e2e/support/monitor.mjs`).

## Separate passes (October 16-31)

`96-year-end-tax`, `97-payroll-override`, `98-handoff-rollover`,
`99-partial-runs` and `99-tags-override-tour` each need Main Campus's
October 16-31 untouched right after `20-payroll-flow`. In the full run 96/97
use it, so the other three skip themselves (saying why); run each in its own
pass:

```powershell
$env:E2E_TIME_TRAVEL=1; $env:E2E_SLOWMO=500
npx playwright test --project=desktop e2e/specs/20-payroll-flow.spec.mjs e2e/specs/98-handoff-rollover.spec.mjs
npx playwright test --project=desktop e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-partial-runs.spec.mjs
npx playwright test --project=desktop e2e/specs/20-payroll-flow.spec.mjs e2e/specs/99-tags-override-tour.spec.mjs
```

Specs written for a fixed date (58 on Nov 2, 96/97/99-partial-runs on Oct 29,
99-tags-override-tour on Oct 30) move the server's "today" back to it when
`E2E_TIME_TRAVEL=1`, and skip with that reason otherwise.

## Output

Everything goes to `test-results/` (git-ignored):

- `test-results/html/index.html`: the report (`npx playwright show-report test-results/html`)
- `test-results/artifacts/<test>/`: `video.webm`, `trace.zip`
  (`npx playwright show-trace <file>`) and a screenshot on failure
- `test-results/screens/`: phone-width dark-mode screenshots of every page
- `test-results/issues.jsonl`: console errors, failed and slow requests per test

## Known flaky tests (to investigate)

| Since | Spec | Symptom | What is known |
| --- | --- | --- | --- |
| 2026-10-29 | `57-decided-rules` (seen in "Government rate tables…" and "Payslip export…") | Fails on the page monitor: `401 GET /api/hr/dashboard`, `/api/hr/teacher-license`, `/api/admin/holidays?upcoming=5` while the test moves from HR to the next role. | Intermittent: failed in 2 of 4 runs on the payroll-override branch, passed 18/18 on a clean re-run; passed on the code before that change too, so not caused by it. The 401s come from HR's portal requests still in flight when `as()` (e2e/support/auth.mjs) clears HR's cookies for the next role, so they leave without a session. Not proven harmless: a real user switching accounts in one browser, or a session renewal racing a request, could see the same 401 (src/proxy.js `withRenewedSession` / `sessionRejection`). To do: reproduce with tracing on, check whether the portal treats such a 401 as "signed out" and redirects, and whether `as()` should wait for the page's requests to settle before switching. |

## Scale test (1,200 employees, 5 years)

Local only; see SCENARIOS.md for the results.

| Command | Does |
| --- | --- |
| `node e2e/scale/seed-scale.mjs --reset` | fresh database + the E2E accounts + 1,210 people in 6 branches, 1.56M attendance rows, 142k payslips, 708 approved runs, 18k leave requests, 1M audit rows (~2 GB, ~10 min) |
| `node e2e/scale/serve.mjs` | production build + `next start` on port 3200 against the local stack |
| `node e2e/scale/measure.mjs [role …]` | times every role's main APIs and every sidebar page; `E2E_SKIP_PAGES=1` for APIs only; results in `test-results/scale/` |
| `node e2e/scale/payroll-run.mjs` | the Main Campus Accountant processes October 1-15 for ~300 people (timed), then the same request twice at once: no duplicate payslips |

Running the normal suite afterwards resets the database (the scale data goes).
