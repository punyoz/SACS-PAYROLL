# Error monitoring (Sentry, free plan)

The app reports errors to Sentry once a DSN is set. Until then it sends
nothing.

## What is reported

| Source | Where |
|---|---|
| Errors no route handler caught | `onRequestError` in `src/instrumentation.js` |
| Errors a route caught and answered with a friendly 500 | `sanitizeError()` in `src/lib/api-error.js` |
| The server's own error log lines (payroll sync, audit log, OTP e-mail, taps not stored) | `console.error`, captured by `src/instrumentation.js` |
| Errors in the browser (portals, RFID terminal) | `src/instrumentation-client.js` |

## What is never sent

Set in `src/lib/monitoring/sentry-options.js`:

- **No session replay** (it would record salaries and ID numbers on screen)
  and **no performance tracing** (keeps the free quota for errors).
- `sendDefaultPii: false`: no IP addresses, no user names or e-mails.
- Before sending, cookies, `Authorization` / kiosk headers, request bodies
  and query strings are removed. Only a user id may remain.

Browser reports go through `/monitoring` on the payroll site itself, so the
Content-Security-Policy needs no Sentry address and ad blockers do not drop
them.

## Set up (once)

1. Create a free account at sentry.io → **Create project** → platform
   **Next.js** → name it `sacs-payroll`. Skip the wizard's code changes (they
   are already in the repo).
2. Project → Settings → **Client Keys (DSN)**: copy the DSN.
3. On the host (Production), add `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`,
   both set to that DSN, and `SENTRY_ENVIRONMENT=production`. Redeploy
   (the browser DSN is built in).
4. Optional, readable stack traces: Settings → Auth Tokens → create a token
   with `project:releases` and `org:read`; add `SENTRY_AUTH_TOKEN` (secret),
   `SENTRY_ORG` (your org slug) and `SENTRY_PROJECT=sacs-payroll`.
5. Sentry → Alerts → **Create alert**: "A new issue is created" → e-mail the
   Super Admin. Add "Number of events > 10 in 1 hour" for spikes.
6. Check it works without touching payroll data: open the sign-in page,
   press F12 → Console, and run
   `setTimeout(() => { throw new Error("Sentry test from SACS Payroll"); });`.
   Within a minute it appears under Sentry → Issues. Mark it Resolved.

## Free plan limits

About 5,000 errors a month and one user seat (check sentry.io/pricing for
current limits). If a bug floods the quota, Sentry drops further events
until the month resets; fix the bug, then use Issues → Ignore for noise.

## Without Sentry

Errors still appear in the host's function logs (e.g. Vercel → Logs,
kept for a short time) and the uptime monitor on `/api/health` still alerts
when the site is down (docs/backup-and-restore.md section 5).
