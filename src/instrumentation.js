import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/monitoring/sentry-options";

/**
 * Server-side error monitoring (Next.js instrumentation hook). Off until
 * SENTRY_DSN is set on the host (docs/monitoring.md).
 *
 * Reports: errors no handler caught (onRequestError), the server's own
 * console.error lines (payroll sync, audit log, OTP mail failures), and the
 * 500s the API routes answer (src/lib/api-error.js).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      ...sentryOptions(process.env.SENTRY_DSN),
      integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
    });
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(sentryOptions(process.env.SENTRY_DSN));
  }
}

export const onRequestError = Sentry.captureRequestError;
