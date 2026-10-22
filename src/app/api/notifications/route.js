/**
 * The signed-in user's stored notifications (public.notifications,
 * 20261014010000): written by the payroll approval functions, e.g. "Payroll
 * waiting for approval" to every HR account, "Payroll approved / rejected"
 * to the Accountant who submitted.
 *
 *   GET                       the latest 30 and how many are unread
 *   PATCH { ids?: [...] }     mark those (or, with no ids, all) as read
 *
 * Every role reaches it (module "profile", self-scoped); the recipient is
 * always the session's own account, never one named in the request.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { forEachInChunk } from "@/lib/supabase/fetch-all";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "profile", "read");
    if (guard.denied) return guard.denied;
    if (!UUID.test(guard.userId)) return NextResponse.json({ notifications: [], unread: 0 });
    const supabase = getAdminClient();
    const [list, unread] = await Promise.all([
      supabase.from("notifications").select("id,kind,title,body,link_page,run_id,read_at,created_at")
        .eq("recipient_id", guard.userId).order("created_at", { ascending: false }).limit(30),
      supabase.from("notifications").select("id", { count: "exact", head: true })
        .eq("recipient_id", guard.userId).is("read_at", null),
    ]);
    if (list.error) return NextResponse.json({ notifications: [], unread: 0, available: false });
    return NextResponse.json({ notifications: list.data || [], unread: unread.count || 0, available: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "profile", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => UUID.test(id)).slice(0, 200);
    const markRead = () => getAdminClient().from("notifications").update({ read_at: new Date().toISOString() })
      .eq("recipient_id", guard.userId).is("read_at", null);
    // A list of ids goes in chunks (200 UUIDs make too long a URL).
    const result = ids.length ? await forEachInChunk(ids, (part) => markRead().in("id", part)) : await markRead();
    if (result.error) return NextResponse.json({ error: sanitizeError(result.error) }, { status: 400 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
