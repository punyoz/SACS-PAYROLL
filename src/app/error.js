'use client';

import "@/styles/ui.css";
import { PortalLayout } from "@/components/portal/portal-layout";
import { ErrorScreen } from "@/components/portal/status-screen";

/**
 * Route-level error boundary, in the portals' shadcn style
 * (src/components/portal/status-screen.jsx). Without it a thrown error showed
 * the bare Next.js error screen. Only the error's digest is shown: it finds
 * the error in the server logs without revealing the message or stack.
 *
 * Failures in the root layout itself are global-error.js, which keeps its
 * inline styles because no stylesheet can be relied on there.
 */
export default function ErrorBoundary({ error, reset }) {
  return (
    <PortalLayout>
      <ErrorScreen error={error} reset={reset} />
    </PortalLayout>
  );
}
