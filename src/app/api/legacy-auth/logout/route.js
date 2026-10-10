/**
 * POST /api/legacy-auth/logout
 *
 * Expires the signed RBAC session cookie issued at login. The portals already
 * clear their localStorage context on sign-out (src/lib/portal/api.js); this
 * clears the half of the session the browser cannot reach, so signing out
 * genuinely ends API access rather than only hiding the UI.
 */

import { NextResponse } from "next/server";
import { clearSession } from "@/lib/rbac/session";

export async function POST() {
  return clearSession(NextResponse.json({ success: true }));
}
