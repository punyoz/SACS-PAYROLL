/**
 * Stand-in for @sentry/nextjs under the test runner (vitest.config.mjs
 * alias). The real SDK is large: every API route imports it through
 * src/lib/api-error.js, and loading it in each parallel test worker on a cold
 * disk pushed the first test of a file past its timeout. Tests never send
 * reports, so no-ops are enough.
 */

export const captureException = () => {};
export const captureRequestError = () => {};
export const captureRouterTransitionStart = () => {};
export const captureConsoleIntegration = () => ({ name: "CaptureConsole" });
export const init = () => {};
