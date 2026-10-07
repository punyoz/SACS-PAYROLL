import { ThemeScope } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";
import { fontVariables } from "@/lib/fonts";

/**
 * The root of a React portal route (its layout.js): theme scope with
 * light / dark / device mode, the brand fonts and the toast stack. The
 * route's layout imports "@/styles/ui.css" itself so Tailwind only loads
 * where these screens are.
 */
export function PortalLayout({ children }) {
  return (
    <ThemeScope className={`${fontVariables} min-h-dvh font-sans antialiased`} portalClassName={fontVariables}>
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </ThemeScope>
  );
}
