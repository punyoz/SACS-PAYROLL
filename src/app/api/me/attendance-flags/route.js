/**
 * The signed-in person's open attendance flags (Part E step 2): days the
 * system found to fix (a missing tap, an absence or short day with nothing
 * filed, overtime not filed). Pinned to the session user (guard.userId).
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";

const DAY_CODES = ["missing_tap", "absent_no_request", "short_day", "overtime_unfiled"];

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "my_account", "read");
    if (guard.denied) return guard.denied;
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("automation_actions")
      .select("id,rule,summary,data,entity_id,created_at")
      .eq("module", "attendance_flags").eq("status", "open").eq("employee_id", guard.userId)
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    const flags = (data || []).filter((f) => DAY_CODES.includes(f.data?.code)).map((f) => ({
      id: f.id, code: f.data.code, log_id: f.entity_id, log_date: f.data.log_date, summary: f.summary, rule: f.rule,
      status: f.data.status || null, time_in: f.data.time_in || null, time_out: f.data.time_out || null,
    }));
    return NextResponse.json({ flags });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
