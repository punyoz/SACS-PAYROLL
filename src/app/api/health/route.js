import { NextResponse } from "next/server";
import { getCachedServiceClient } from "@/lib/supabase/admin";

/**
 * GET /api/health: public liveness check for an uptime monitor
 * (docs/hosting-and-operations.md).
 *
 * It runs one tiny database read, so "up" means the app can reach the
 * database, not just that the web server answers. It returns only up / down,
 * never data or error text. Listed as public in src/proxy.js.
 * (The daily keep-alive ping for the Free plan was removed on 2026-11-05:
 * Supabase Pro projects are never paused.)
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const { error } = await getCachedServiceClient()
      .from("branches")
      .select("id")
      .limit(1);
    if (error) throw error;
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
}
