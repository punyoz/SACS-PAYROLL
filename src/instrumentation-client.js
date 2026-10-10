import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/monitoring/sentry-options";

/**
 * Browser error monitoring: errors thrown in the portals. Off until
 * NEXT_PUBLIC_SENTRY_DSN is set at build time (docs/monitoring.md). No
 * session replay and no tracing (src/lib/monitoring/sentry-options.js).
 */
Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
