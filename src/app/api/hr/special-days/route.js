/**
 * Special working days (20261124130000, 2026-11-23): e.g. Saturday classes.
 *
 *   GET    ?from=YYYY-MM-DD   the declared days from that date (default: 60 days back), newest first
 *   POST   { work_date, branch_ids[], audience: all|teaching|non_teaching|employees, employee_ids[],
 *            start_time "HH:MM", end_time, reason, pay_type: makeup|extra, premium_pct? }
 *          HR or the Super Admin. The covered employees are notified.
 *   PATCH  { id, action: "cancel", reason }   HR or the Super Admin; not after the day.
 *
 * The schedule (attendance_schedule_for) and payroll read the table; nothing
 * else is written here.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { manilaDateKey } from "@/lib/payroll/periods";
import { coveredBySpecialDay, specialDayLabel, SPECIAL_DAY_AUDIENCES, SPECIAL_DAY_PAY } from "@/lib/attendance/special-days";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = "Special working days are not set up yet: apply 20261124130000_special_working_days.sql.";
const canManage = (guard) => guard.role === "hr" || guard.role === "super_admin";

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "attendance", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const from = DATE.test(url.searchParams.get("from") || "") ? url.searchParams.get("from")
      : new Date(Date.parse(`${manilaDateKey()}T00:00:00Z`) - 60 * 864e5).toISOString().slice(0, 10);
    const supabase = getAdminClient();
    const result = await fetchAllRows(() => supabase.from("special_working_days").select("*").gte("work_date", from)
      .order("work_date", { ascending: false }).order("id", { ascending: true }));
    if (result.error) return NextResponse.json({ available: false, error: NOT_READY, days: [] });
    const days = (result.data || []).filter((d) => guard.branchExempt || !d.branch_ids?.length || d.branch_ids.includes(guard.branchId));
    return NextResponse.json({ available: true, days: days.map((d) => ({ ...d, label: specialDayLabel(d) })), can_manage: canManage(guard) });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "attendance", "read");
    if (guard.denied) return guard.denied;
    if (!canManage(guard)) return NextResponse.json({ error: "HR declares special working days." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const workDate = normalizeText(body.work_date);
    const start = normalizeText(body.start_time).slice(0, 5);
    const end = normalizeText(body.end_time).slice(0, 5);
    const reason = normalizeText(body.reason);
    const audience = normalizeText(body.audience);
    const payType = normalizeText(body.pay_type);
    const branchIds = [...new Set((Array.isArray(body.branch_ids) ? body.branch_ids : []).map((v) => normalizeText(v)).filter((v) => UUID.test(v)))];
    const employeeIds = [...new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).map((v) => normalizeText(v)).filter((v) => UUID.test(v)))];
    if (!DATE.test(workDate)) return NextResponse.json({ error: "Choose the date." }, { status: 400 });
    if (workDate < manilaDateKey()) return NextResponse.json({ error: "Choose today or a later date." }, { status: 400 });
    if (!TIME.test(start) || !TIME.test(end) || end <= start) return NextResponse.json({ error: "Enter the hours: a start time and a later end time." }, { status: 400 });
    if (!SPECIAL_DAY_AUDIENCES[audience]) return NextResponse.json({ error: "Choose who works that day." }, { status: 400 });
    if (audience === "employees" && !employeeIds.length) return NextResponse.json({ error: "Choose the employees." }, { status: 400 });
    if (!SPECIAL_DAY_PAY[payType]) return NextResponse.json({ error: "Choose the pay type: make-up day or extra working day." }, { status: 400 });
    if (reason.length < 3 || reason.length > 300) return NextResponse.json({ error: "Give the reason (3 to 300 characters)." }, { status: 400 });
    const supabase = getAdminClient();
    const cfg = await supabase.from("system_config").select("value").eq("section", "attendance").eq("key", "extra_working_day_pct").maybeSingle();
    const pct = body.premium_pct !== undefined && body.premium_pct !== "" ? Number(body.premium_pct) : Number(cfg.data?.value) || 130;
    if (!(pct >= 100 && pct <= 400)) return NextResponse.json({ error: "The extra-day rate is 100% to 400% of the daily rate." }, { status: 400 });
    const by = normalizeText(guard.session?.full_name, guard.session?.email);
    const row = {
      work_date: workDate, branch_ids: branchIds, audience, employee_ids: audience === "employees" ? employeeIds : [],
      start_time: start, end_time: end, reason, pay_type: payType, premium_pct: pct, created_by: guard.userId, created_by_name: by,
    };
    const saved = await supabase.from("special_working_days").insert(row).select("*").single();
    if (saved.error) return NextResponse.json({ error: String(saved.error.code) === "42P01" ? NOT_READY : sanitizeError(saved.error) }, { status: saved.error.code === "42P01" ? 503 : 400 });

    // Tell the covered employees ahead of time.
    const people = await fetchAllRows(() => supabase.from("profiles").select("id,branch_id,employee_type,role,archived,on_payroll").eq("archived", false).order("id", { ascending: true }));
    const covered = (people.data || []).filter((p) => p.on_payroll && ["employee", "accountant", "hr"].includes(String(p.role).toLowerCase()) && coveredBySpecialDay(saved.data, p));
    const label = specialDayLabel(saved.data);
    if (covered.length) {
      await supabase.from("notifications").insert(covered.map((p) => ({
        recipient_id: p.id, kind: "special_working_day", title: `Special working day: ${label.date}`,
        body: `${label.kind}, ${label.hours}. ${reason}`,
        link_page: String(p.role).toLowerCase() === "hr" ? "hr-my-attendance" : String(p.role).toLowerCase() === "accountant" ? "ac-my-attendance" : "emp-attendance",
      })));
    }
    await appendAuditLog({
      actor: guard, module: "attendance", action: "special_working_day_add", entity_type: "special_working_day", entity_id: saved.data.id,
      status: "success", source: "api", description: `Special working day ${label.date} (${label.kind}, ${label.hours}) for ${label.who}: ${reason}. ${covered.length} notified.`,
      metadata: { ...row, notified: covered.length },
    });
    return NextResponse.json({ success: true, day: { ...saved.data, label }, notified: covered.length });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "attendance", "read");
    if (guard.denied) return guard.denied;
    if (!canManage(guard)) return NextResponse.json({ error: "HR declares special working days." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const id = normalizeText(body.id);
    const reason = normalizeText(body.reason);
    if (!UUID.test(id) || normalizeText(body.action) !== "cancel") return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (reason.length < 5) return NextResponse.json({ error: "Give the reason for cancelling it (at least 5 characters)." }, { status: 400 });
    const supabase = getAdminClient();
    const found = (await supabase.from("special_working_days").select("*").eq("id", id).maybeSingle()).data;
    if (!found || found.cancelled_at) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (found.work_date < manilaDateKey()) return NextResponse.json({ error: "A past day can't be cancelled: its attendance is already recorded." }, { status: 409 });
    const by = normalizeText(guard.session?.full_name, guard.session?.email);
    await supabase.from("special_working_days").update({ cancelled_at: new Date().toISOString(), cancelled_by_name: by }).eq("id", id);
    await appendAuditLog({
      actor: guard, module: "attendance", action: "special_working_day_cancel", entity_type: "special_working_day", entity_id: id,
      status: "success", source: "api", description: `Special working day ${found.work_date} cancelled by ${by}: ${reason}.`, metadata: { reason },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
