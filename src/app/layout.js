import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const metadata = {
  title: "SACS Payroll",
  description: "SACS Payroll Management System",
};

// Mobile browser chrome in the school's primary green (brand token
// --color-primary). The favicon and Apple touch icon are app/icon.svg and
// app/apple-icon.png, which Next.js picks up by file name.
export const viewport = {
  themeColor: "#1B5E3C",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
