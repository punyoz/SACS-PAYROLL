/**
 * GET: the special working days that cover the signed-in person, from today
 * (2026-11-23; HR declares them in Holidays & Duty). Read-only.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey } from "@/lib/payroll/periods";
import { coveredBySpecialDay, specialDayLabel } from "@/lib/attendance/special-days";

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "my_account", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const [{ data: me }, days] = await Promise.all([
      supabase.from("profiles").select("id,branch_id,employee_type").eq("id", guard.userId).maybeSingle(),
      supabase.from("special_working_days").select("*").gte("work_date", manilaDateKey()).is("cancelled_at", null).order("work_date", { ascending: true }).limit(50),
    ]);
    if (days.error) return NextResponse.json({ days: [] });
    const mine = (days.data || []).filter((d) => coveredBySpecialDay(d, me));
    return NextResponse.json({ days: mine.map((d) => ({ id: d.id, work_date: d.work_date, reason: d.reason, pay_type: d.pay_type, label: specialDayLabel(d) })) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
