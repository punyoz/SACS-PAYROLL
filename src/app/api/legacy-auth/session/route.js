/**
 * GET /api/legacy-auth/session
 *
 * Lightweight heartbeat the portals poll. The real work happens in src/proxy.js
 * before this handler runs: a cookie that is no longer the account's active
 * sign-in never gets here and is answered with 401 "session_replaced", which
 * the portal turns into an automatic sign-out.
 */

import { NextResponse } from "next/server";
import { readSession } from "@/lib/rbac/session";

export async function GET(request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "Your session has expired. Please sign in again." }, { status: 401 });
  }

  return NextResponse.json(
    {
      authenticated: true,
      role: session.role,
      must_change_password: Boolean(session.pwd),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
