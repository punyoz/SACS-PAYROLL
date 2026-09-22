import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const metadata = {
  title: "SACS Payroll",
  description: "SACS Payroll Management System",
};

// Mirrors the portal's saved theme onto this outer page before first paint.
// Every sign-in and sign-out is a full navigation, and until the portal frame
// paints, what shows is this page's background — always dark, so light-theme
// users saw a dark flash on every one. globals.css keys the frame's backdrop
// off this attribute. Read-only: the portal (app.js) owns the setting.
const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("sacs-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
