import { withSentryConfig } from "@sentry/nextjs/config";

const isProduction = process.env.NODE_ENV === "production";

// Profile pictures are signed, expiring URLs from this project's Supabase
// Storage (private bucket, /api/profile-photo): only that origin, not "https:".
const SUPABASE_ORIGIN = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").origin; } catch { return ""; }
})();

// The project's Realtime websocket (wss:// for https, ws:// for a local http stack).
const SUPABASE_REALTIME = SUPABASE_ORIGIN ? SUPABASE_ORIGIN.replace(/^http/, "ws") : "";

// Development needs eval (React refresh) and a websocket for hot reload.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src 'self' data: blob:${SUPABASE_ORIGIN ? ` ${SUPABASE_ORIGIN}` : ""}`,
  // The live notification bell (alpha test D2) opens a Supabase Realtime
  // websocket to this project only; nothing else leaves the site.
  `connect-src 'self'${SUPABASE_REALTIME ? ` ${SUPABASE_REALTIME}` : ""}${isProduction ? "" : " ws: wss:"}`,
  // The PWA service worker (alpha test D1) and its manifest: this site only.
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self' data: blob:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The fast attendance tests build into their own folder (NEXT_DIST_DIR),
  // so a running dev server's .next is left alone. Unset everywhere else.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Next 16 writes AGENTS.md and CLAUDE.md into the project root on every dev
  // run. Nothing here reads them, so keep the tree free of generated files.
  agentRules: false,
  // The code emails attach the school seal from disk (src/lib/mail/otp-email.js);
  // ship that file with the API functions that send them.
  outputFileTracingIncludes: {
    "/api/legacy-auth/**": ["./public/brand/logo-160.png"],
    // The seal on payslip PDFs (src/app/api/accountant/payroll/route.js).
    "/api/accountant/payroll": ["./public/brand/seal-payslip.jpg"],
    "/api/hr/payroll-records": ["./public/brand/seal-payslip.jpg"],
  },
  async headers() {
    return [
      {
        // Baseline browser protections on every response. script-src allows
        // 'unsafe-inline' because Next's own inline bootstrap scripts carry no
        // nonce; the rest still blocks plugins, foreign scripts/frames, <base>
        // hijacking, framing by other sites and forms posting elsewhere.
        // data:/blob: frames are the leave-proof PDF viewer.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          ...(isProduction
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

// Error monitoring (src/instrumentation.js, docs/monitoring.md). Browser
// reports go through /monitoring on this site, so the Content-Security-Policy
// above needs no Sentry host and ad blockers do not drop them. Source maps
// upload only when SENTRY_AUTH_TOKEN (+ SENTRY_ORG, SENTRY_PROJECT) is set
// on the host; otherwise the build is unchanged.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: "/monitoring",
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
