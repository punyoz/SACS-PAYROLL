import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ServiceWorkerRegister } from "@/components/portal/service-worker";

export const metadata = {
  title: "SACS Payroll",
  description: "SACS Payroll Management System",
  // Home-screen app (alpha test D1): app/manifest.js; iPhone uses these.
  appleWebApp: { capable: true, title: "SACS Payroll", statusBarStyle: "default" },
};

// Mobile browser chrome in the school's primary green (brand token
// --color-primary). The favicon and Apple touch icon are app/icon.svg and
// app/apple-icon.png, which Next.js picks up by file name.
export const viewport = {
  themeColor: "#1B5E3C",
};

// Vercel Analytics / Speed Insights only exist on Vercel (VERCEL=1 there);
// on any other host their scripts 404 and fill the console with errors.
const ON_VERCEL = Boolean(process.env.VERCEL);

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
        {ON_VERCEL ? <Analytics /> : null}
        {ON_VERCEL ? <SpeedInsights /> : null}
      </body>
    </html>
  );
}
