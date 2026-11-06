/**
 * POST /api/legacy-auth/logout
 *
 * Expires the signed RBAC session cookie issued at login. The portals already
 * clear their localStorage context on sign-out (src/lib/portal/api.js); this
 * clears the half of the session the browser cannot reach, so signing out
 * genuinely ends API access rather than only hiding the UI.
 *
 * On a deliberate Sign out it also ends the sign-in on the server (fix 2026-11-05): a copy of the
 * cookie taken before signing out was still accepted until it expired, since
 * clearing the browser's cookie does not invalidate the signed token. When the
 * cookie is the account's current sign-in, its session id is revoked
 * (src/lib/auth/active-session.js), and src/proxy.js refuses it from then on
 * (within its few-second cache). A cookie from an older, already replaced
 * sign-in leaves the newer one alone.
 */

import { NextResponse } from "next/server";
import { clearSession, readSession } from "@/lib/rbac/session";
import { checkActiveSession, revokeActiveSession } from "@/lib/auth/active-session";

export async function POST(request) {
  const session = request ? readSession(request) : null;
  // Only a deliberate Sign out ({ sign_out: true }, src/lib/portal/api.js)
  // ends the sign-in on the server; the portal's automatic trips to /login
  // only clear the cookie, so a stale tab can never end a newer sign-in.
  const body = request ? await request.json().catch(() => ({})) : {};
  if (body?.sign_out === true && session?.sub && session?.sid) {
    try {
      if (await checkActiveSession(session.sub, session.sid) === "current") {
        await revokeActiveSession(session.sub);
      }
    } catch {
      // Signing out must always clear the cookie, even if the server-side
      // revoke could not be recorded.
    }
  }
  return clearSession(NextResponse.json({ success: true }));
}
