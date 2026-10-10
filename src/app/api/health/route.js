import { NextResponse } from "next/server";
import { getCachedServiceClient } from "@/lib/supabase/admin";

/**
 * GET /api/health: public liveness check for the uptime monitor and the
 * keep-alive workflow (docs/backup-and-restore.md section 5).
 *
 * It runs one tiny database read, so each call is real database activity:
 * that is what keeps a Supabase Free project from pausing over a school
 * break. It returns only up / down, never data or error text. Listed as
 * public in src/proxy.js.
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
