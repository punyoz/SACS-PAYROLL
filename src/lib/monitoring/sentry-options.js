/**
 * Shared Sentry settings (error monitoring, free plan; docs/monitoring.md).
 *
 * Payroll data stays out of Sentry:
 *   - errors only: no performance tracing, no session replay (a replay would
 *     record salaries and ID numbers on screen);
 *   - sendDefaultPii off: no IP addresses or user identity;
 *   - scrub() drops cookies, authorization headers, request bodies and query
 *     strings before anything is sent.
 *
 * With no DSN set, Sentry stays off and nothing is sent.
 */

const SENSITIVE_HEADERS = ["cookie", "authorization", "x-sacs-kiosk", "x-supabase-auth"];

/** beforeSend: remove what could carry personal or payroll data. */
export function scrub(event) {
  if (event?.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.includes(name.toLowerCase())) delete event.request.headers[name];
      }
    }
    if (typeof event.request.url === "string") event.request.url = event.request.url.split("?")[0];
  }
  if (event?.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  return event;
}

export function sentryOptions(dsn) {
  return {
    dsn: dsn || undefined,
    enabled: Boolean(dsn),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrub,
  };
}
