/**
 * Who the signed-in person's own requests wait for (2026-11-23): HR for an
 * employee; for an HR person, another HR officer who covers their branch, or
 * the Super Admin as the stand-in. Pinned to the session user.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { waitingFor } from "@/lib/rbac/routing";

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "my_account", "read");
    if (guard.denied) return guard.denied;
    const supabase = getServiceClient();
    const { data: me } = await supabase.from("profiles").select("id,role,branch_id").eq("id", guard.userId).maybeSingle();
    return NextResponse.json(await waitingFor(supabase, me));
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
