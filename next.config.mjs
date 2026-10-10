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
    "/api/legacy-auth/**": ["./public/brand/logo-160.png"],
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

export default nextConfig;
