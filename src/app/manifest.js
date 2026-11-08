/**
 * Web app manifest (alpha test D1, 2026-11-09): SACS Payroll can be added to
 * a phone's home screen and opens in its own window. Served by Next.js at
 * /manifest.webmanifest. Icons: public/icons (made from the school seal).
 */
export default function manifest() {
  return {
    name: "SACS Payroll",
    short_name: "SACS Payroll",
    description: "SACS Payroll Management System",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#FFFFFF",
    theme_color: "#1B5E3C",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
