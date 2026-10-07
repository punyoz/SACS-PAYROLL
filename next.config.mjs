const isProduction = process.env.NODE_ENV === "production";

// Development needs eval (React refresh) and a websocket for hot reload.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self'${isProduction ? "" : " ws: wss:"}`,
  "frame-src 'self' data: blob:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Next 16 writes AGENTS.md and CLAUDE.md into the project root on every dev
  // run. Nothing here reads them, so keep the tree free of generated files.
  agentRules: false,
  // The code emails attach the school seal from disk (src/lib/mail/otp-email.js);
  // ship that file with the API functions that send them.
  outputFileTracingIncludes: {
    "/api/legacy-auth/**": ["./public/legacy/assets/logo-160.png"],
  },
  async rewrites() {
    return [
      { source: "/rfid-terminal", destination: "/legacy/rfid-terminal.html" },
    ];
  },
  async headers() {
    return [
      {
        // Baseline browser protections on every response. The legacy portals
        // rely on inline <script> and onclick="" handlers, so script-src has
        // to allow 'unsafe-inline' for now; the rest still blocks plugins,
        // foreign scripts/frames, <base> hijacking, framing by other sites
        // and forms posting elsewhere. frame-ancestors is 'self' because the
        // Next pages embed the legacy portal in a same-origin iframe
        // (src/app/_components/LegacyRoleFrame.js). data:/blob: frames are
        // the leave-proof PDF viewer.
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
      {
        // Legacy HTML pages must always revalidate so the cache-busting
        // ?v= query string they generate at runtime stays fresh.
        source: "/legacy/:path*.html",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        // CSS/JS bundles are already fingerprinted by the ?v= query string
        // emitted from legacy/index.html, so the browser can cache them.
        source: "/legacy/:dir(css|js)/:file*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
