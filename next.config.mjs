/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  compress: true,
  async headers() {
    return [
      {
        // Long-lived cache for legacy static assets. They are fingerprinted by deploy
        // (overwritten on each release), so a long max-age is safe with must-revalidate.
        source: "/legacy/:path*.css",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, must-revalidate" },
        ],
      },
      {
        source: "/legacy/:path*.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, must-revalidate" },
        ],
      },
      {
        // HTML fragments — keep fresh but allow short SWR so reloads feel instant.
        source: "/legacy/:path*.html",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=86400" },
        ],
      },
    ];
  },
};

export default nextConfig;
