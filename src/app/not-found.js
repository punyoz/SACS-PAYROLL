import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";
import { NotFoundScreen } from "@/components/portal/status-screen";

/**
 * 404 page, in the portals' shadcn style (src/components/portal/status-screen.jsx).
 * Its way out is the signed-in person's own portal, or /login.
 */

export const metadata = {
  title: "Page not found — SACS Payroll",
};

export default function NotFound() {
  return (
    <PortalLayout>
      <NotFoundScreen />
    </PortalLayout>
  );
}
