/**
 * Substitute teaching (Part C, 2026-11-22; 20261123020000). Attendance and
 * payroll only: no timetable. The proxy maps this route to "branch_oversight".
 * 2026-11-24: an approved teacher's leave gets a system proposal per school day
 * (src/lib/substitutions/proposals.js); HR picks the teacher and approves. HR
 * files one by hand only for an unplanned absence. The Admin views only.
 *
 *   GET  ?from=&to=&status=             the substitutions (Admin: own branch), each with its tap check
 *   GET  ?suggest=1&absent=&date=&periods=   suggested substitutes (same level and branch, tapped in
 *                                       that day, not on leave, under the weekly cap)
 *   PATCH { action: "file_unplanned", unplanned_reason: no_show|sudden_illness|other, absent_employee_id,
 *           substitute_id, sub_date, start_time, end_time, periods, class_section?, subject? }   (HR: approved on filing)
 *   PATCH { id, action: "approve", substitute_id?, periods?, remark }   (HR; a proposal needs the picked teacher; periods covered)
 *   PATCH { id, action: "reject", remark }   (HR; a preset remark)
 *   PATCH { id, action: "cancel" }           (HR, while pending)
 *   POST  refused (the Admin no longer files)
 */

import { NextResponse } from "next/server";
import { requirePermission, denyForeignBranch } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { remarkClient, resolveRemark } from "@/lib/remarks/presets";
import { manilaDateKey } from "@/lib/payroll/periods";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { lateSubstitutions, minutesOf, readSubstitutionSettings, suggestSubstitutes, tapsConfirm, weekOf } from "@/lib/substitutions/pay";

const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COLUMNS = "id,branch_id,sub_date,absent_employee_id,substitute_id,start_time,end_time,periods,class_section,subject,leave_request_id,status,source,created_by_name,created_at,decided_by_name,decided_at,decision_note";
/** HR files a substitution by hand only for an unplanned absence (2026-11-24); planned leave gets a system proposal. */
const UNPLANNED = { no_show: "No-show", sudden_illness: "Sudden illness", other: "Other unplanned absence" };
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const manilaMinutes = (iso) => {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

async function people(supabase, ids) {
  if (!ids.length) return new Map();
  const { data } = await fetchAllIn(() => supabase.from("profiles").select("id,full_name,employee_id,branch_id,employee_level,employee_type,archived,role").order("id"), "id", ids);
  return new Map((data || []).map((p) => [p.id, p]));
}

/** Substitution periods already open or approved, per substitute, in the week of `date`. */
async function weekPeriods(supabase, ids, date, exceptId = null) {
  const monday = weekOf(date);
  const q = () => supabase.from("substitutions").select("id,substitute_id,periods").in("status", ["pending", "approved"])
    .gte("sub_date", monday).lte("sub_date", addDays(monday, 6)).order("id");
  // Id lists are read in chunks (tests/scale-queries.test.js).
  const { data } = ids ? await fetchAllIn(q, "substitute_id", ids) : await q();
  const map = new Map();
  for (const r of data || []) if (r.id !== exceptId && r.substitute_id) map.set(r.substitute_id, (map.get(r.substitute_id) || 0) + Number(r.periods || 0));
  return map;
}

async function suggestions(supabase, guard, { absentId, date, periods }) {
  const absent = (await supabase.from("profiles").select("id,full_name,branch_id,employee_level").eq("id", absentId).maybeSingle()).data;
  if (!absent) return { error: "The absent teacher was not found." };
  const foreign = denyForeignBranch(guard, absent.branch_id);
  if (foreign) return { denied: foreign };
  const { data: staff } = await supabase.from("profiles").select("id,full_name,branch_id,employee_level,employee_type").eq("branch_id", absent.branch_id)
    .eq("archived", false).neq("on_payroll", false).in("role", ["employee", "accountant"]);
  const ids = (staff || []).map((p) => p.id);
  const [{ data: logs }, { data: leaves }, settings, week] = await Promise.all([
    fetchAllIn(() => supabase.from("attendance_logs").select("employee_id,time_in").eq("log_date", date).eq("archived_duplicate", false).not("time_in", "is", null).order("employee_id"), "employee_id", ids),
    supabase.from("leave_requests").select("employee_id,start_date,end_date").eq("status", "approved").lte("start_date", date).gte("end_date", date),
    readSubstitutionSettings(supabase),
    weekPeriods(supabase, ids, date),
  ]);
  // A future date: nobody has tapped yet, so the tap filter waits for the day (the taps still confirm the pay).
  const future = date > manilaDateKey();
  const tapped = future ? new Set(ids) : new Set((logs || []).map((l) => l.employee_id));
  const onLeave = new Set((leaves || []).map((l) => String(l.employee_id)));
  return { suggestions: suggestSubstitutes({ absent, people: staff || [], tapped, onLeave, weekPeriods: week, periods, cap: settings.substitution_cap_periods_week }), cap: settings.substitution_cap_periods_week, future };
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const supabase = getServiceClient();
    if (url.searchParams.get("suggest") === "1") {
      const absentId = url.searchParams.get("absent") || "";
      const date = url.searchParams.get("date") || "";
      const periods = Number(url.searchParams.get("periods") || 1);
      if (!UUID.test(absentId) || !DAY.test(date)) return NextResponse.json({ error: "Choose the absent teacher and the date." }, { status: 400 });
      const out = await suggestions(supabase, guard, { absentId, date, periods: Number.isInteger(periods) && periods > 0 ? periods : 1 });
      if (out.denied) return out.denied;
      if (out.error) return NextResponse.json({ error: out.error }, { status: 404 });
      return NextResponse.json(out);
    }
    // Approved after their cutoff was processed (Part C): paid on the next payslip; the Accountant's Action needed.
    if (url.searchParams.get("late") === "1") {
      const since = addDays(manilaDateKey(), -62);
      let lq = supabase.from("substitutions").select(COLUMNS).eq("status", "approved").gte("sub_date", since);
      if (!guard.branchExempt) lq = lq.eq("branch_id", guard.branchId);
      const { data: approved } = await lq;
      const subIds = [...new Set((approved || []).map((r) => r.substitute_id))];
      const { data: entries } = subIds.length
        ? await supabase.from("payroll_entries").select("id,employee_id,status,pay_period,payroll").neq("status", "draft").gte("created_at", `${since}T00:00:00Z`).in("employee_id", subIds)
        : { data: [] };
      const late = lateSubstitutions(approved || [], entries || []);
      const rows = (approved || []).filter((r) => late.has(r.id));
      const who = await people(supabase, [...new Set(rows.flatMap((r) => [r.absent_employee_id, r.substitute_id]))]);
      return NextResponse.json({ late: rows.map((r) => ({ ...r, substitute_name: who.get(r.substitute_id)?.full_name || "—", absent_name: who.get(r.absent_employee_id)?.full_name || "—" })) });
    }
    // The branch's teachers (the form's absent-teacher list) and their approved leave around today
    // (from 7 days back to 14 ahead): "Arrange substitute" starts from these.
    if (url.searchParams.get("teachers") === "1") {
      let tq = supabase.from("profiles").select("id,full_name,employee_id,branch_id,employee_level").eq("archived", false).neq("on_payroll", false)
        .in("role", ["employee", "accountant"]).or("employee_type.is.null,employee_type.ilike.teaching").order("full_name", { ascending: true });
      if (!guard.branchExempt) tq = tq.eq("branch_id", guard.branchId);
      const { data: teachers } = await tq;
      const ids = (teachers || []).map((t) => t.id);
      const today = manilaDateKey();
      const { data: leaves } = ids.length
        ? await fetchAllIn(() => supabase.from("leave_requests").select("id,employee_id,leave_type,start_date,end_date,half_day").eq("status", "approved")
          .gte("end_date", addDays(today, -7)).lte("start_date", addDays(today, 14)).order("start_date", { ascending: true }), "employee_id", ids)
        : { data: [] };
      const nameOf = new Map((teachers || []).map((t) => [t.id, t.full_name]));
      return NextResponse.json({ teachers: teachers || [], on_leave: (leaves || []).map((l) => ({ ...l, employee_name: nameOf.get(l.employee_id) || "—" })) });
    }
    const from = url.searchParams.get("from") || addDays(manilaDateKey(), -45);
    const to = url.searchParams.get("to") || addDays(manilaDateKey(), 45);
    if (!DAY.test(from) || !DAY.test(to)) return NextResponse.json({ error: "Choose a valid date range." }, { status: 400 });
    let q = supabase.from("substitutions").select(COLUMNS).gte("sub_date", from).lte("sub_date", to).order("sub_date", { ascending: false }).limit(1000);
    if (!guard.branchExempt) q = q.eq("branch_id", guard.branchId);
    const status = url.searchParams.get("status");
    if (status && status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data || [];
    const who = await people(supabase, [...new Set(rows.flatMap((r) => [r.absent_employee_id, r.substitute_id]).filter(Boolean))]);
    const dates = [...new Set(rows.map((r) => r.sub_date))];
    const { data: logs } = dates.length
      ? await supabase.from("attendance_logs").select("employee_id,log_date,time_in,time_out").in("log_date", dates).eq("archived_duplicate", false).in("employee_id", [...new Set(rows.map((r) => r.substitute_id).filter(Boolean)), "00000000-0000-0000-0000-000000000000"])
      : { data: [] };
    const tapOf = new Map((logs || []).map((l) => [`${l.employee_id}|${l.log_date}`, { in: manilaMinutes(l.time_in), out: manilaMinutes(l.time_out) }]));
    const today = manilaDateKey();
    return NextResponse.json({
      substitutions: rows.map((r) => {
        const taps = tapOf.get(`${r.substitute_id}|${r.sub_date}`) || null;
        const confirmed = tapsConfirm(r, taps);
        return {
          ...r,
          absent_name: who.get(r.absent_employee_id)?.full_name || "—",
          substitute_name: r.substitute_id ? who.get(r.substitute_id)?.full_name || "—" : null,
          substitute_code: r.substitute_id ? who.get(r.substitute_id)?.employee_id || "" : "",
          // A system proposal (from approved leave) waits for HR to pick the teacher.
          needs_substitute: !r.substitute_id && r.status === "pending",
          hours: (minutesOf(r.end_time) - minutesOf(r.start_time)) / 60,
          // Taps confirm it; a past day without covering taps is flagged to HR (not paid).
          tap_check: !r.substitute_id ? "no_substitute" : confirmed ? "confirmed" : r.sub_date >= today ? "waiting" : "no_taps",
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

/**
 * HR files a substitution for an unplanned absence (no-show, sudden illness), decided by that HR on filing.
 * Reached by PATCH { action: "file_unplanned", ... } (HR holds update on this module, not create); the branch
 * Admin's POST is refused (2026-11-24).
 */
async function fileUnplanned(guard, body) {
    // 2026-11-24: the system proposes a substitution from an approved leave; HR files one by hand only for an
    // unplanned absence (no-show, sudden illness), decided by that HR on filing. The branch Admin does not file.
    if (guard.role !== "hr" && guard.role !== "super_admin") {
      return NextResponse.json({ error: "Substitutions come from approved leave (the system proposes them; HR picks the teacher). HR files one by hand only for an unplanned absence." }, { status: 409 });
    }
    const unplanned = UNPLANNED[String(body.unplanned_reason || "")] ? String(body.unplanned_reason) : null;
    if (!unplanned) return NextResponse.json({ error: "A substitution filed by hand is for an unplanned absence: choose No-show, Sudden illness or Other unplanned absence." }, { status: 400 });
    const absentId = String(body.absent_employee_id || "");
    const substituteId = String(body.substitute_id || "");
    const date = String(body.sub_date || "");
    const start = minutesOf(body.start_time);
    const end = minutesOf(body.end_time);
    const periods = Number(body.periods);
    if (!UUID.test(absentId) || !UUID.test(substituteId)) return NextResponse.json({ error: "Choose the absent teacher and the substitute." }, { status: 400 });
    if (absentId === substituteId) return NextResponse.json({ error: "The substitute cannot be the absent teacher." }, { status: 400 });
    if (!DAY.test(date)) return NextResponse.json({ error: "Choose the date." }, { status: 400 });
    if (start === null || end === null || end <= start) return NextResponse.json({ error: "Enter the start and end time (HH:MM); the end after the start." }, { status: 400 });
    if (!Number.isInteger(periods) || periods < 1 || periods > 10) return NextResponse.json({ error: "Enter the number of class periods (1 to 10)." }, { status: 400 });
    const text = (v) => String(v || "").trim().replace(/\s+/g, " ").slice(0, 80) || null;
    const supabase = getServiceClient();
    const out = await suggestions(supabase, guard, { absentId, date, periods });
    if (out.denied) return out.denied;
    if (out.error) return NextResponse.json({ error: out.error }, { status: 404 });
    // The server checks the same rules the suggestions use: only a suggested teacher may be chosen.
    if (!out.suggestions.some((s) => s.id === substituteId)) {
      return NextResponse.json({ error: `That teacher cannot substitute here: same level and branch, tapped in that day, not on leave, and at most ${out.cap} periods a week.` }, { status: 400 });
    }
    // Planned leave is covered by the system's proposal, not a second filing.
    const { data: onLeave } = await supabase.from("leave_requests").select("id").eq("employee_id", absentId).eq("status", "approved").lte("start_date", date).gte("end_date", date).limit(1);
    if ((onLeave || []).length) return NextResponse.json({ error: "This teacher is on approved leave that day: the system has proposed the substitution. Pick the teacher on it." }, { status: 409 });
    const absent = (await supabase.from("profiles").select("branch_id").eq("id", absentId).maybeSingle()).data;
    const by = guard.session?.full_name || guard.session?.email || "HR";
    const now = new Date().toISOString();
    const { data, error } = await supabase.from("substitutions").insert({
      branch_id: absent?.branch_id || null, sub_date: date, absent_employee_id: absentId, substitute_id: substituteId,
      start_time: body.start_time, end_time: body.end_time, periods, class_section: text(body.class_section), subject: text(body.subject),
      leave_request_id: null, source: "unplanned", status: "approved",
      created_by: guard.userId, created_by_name: by, decided_by: guard.userId, decided_by_name: by, decided_at: now,
      decision_note: `Unplanned absence: ${UNPLANNED[unplanned]}`,
    }).select(COLUMNS).single();
    if (error) {
      if (String(error.code) === "23505") return NextResponse.json({ error: "This substitute already has a substitution at that time." }, { status: 409 });
      throw error;
    }
    await appendAuditLog({ actor: guard, module: "payroll", action: "substitution_filed_unplanned", entity_type: "substitution", entity_id: data.id, branch_id: data.branch_id,
      description: `Substitution for an unplanned absence (${UNPLANNED[unplanned]}) on ${date} ${body.start_time}-${body.end_time} (${periods} period${periods === 1 ? "" : "s"}), filed and approved by ${by}.` });
    return NextResponse.json({ substitution: data }, { status: 201 });
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "create");
    if (guard.denied) return guard.denied;
    return await fileUnplanned(guard, await request.json().catch(() => ({})));
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const guard = await requirePermission(request, "branch_oversight", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const action = String(body.action || "");
    if (action === "file_unplanned") return await fileUnplanned(guard, body);
    if (!UUID.test(id)) return NextResponse.json({ error: "Choose a substitution." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: row } = await supabase.from("substitutions").select(COLUMNS).eq("id", id).maybeSingle();
    if (!row) return NextResponse.json({ error: "Substitution not found." }, { status: 404 });
    const foreign = denyForeignBranch(guard, row.branch_id);
    if (foreign) return foreign;
    if (row.status !== "pending") return NextResponse.json({ error: `This substitution is already ${row.status}.` }, { status: 409 });
    const by = guard.session?.full_name || guard.session?.email || guard.role;
    const now = new Date().toISOString();

    if (action === "cancel") {
      if (guard.role !== "hr" && guard.role !== "super_admin") return NextResponse.json({ error: "HR cancels a substitution." }, { status: 403 });
      const { error } = await supabase.from("substitutions").update({ status: "cancelled", updated_at: now }).eq("id", id).eq("status", "pending");
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (action !== "approve" && action !== "reject") return NextResponse.json({ error: "Approve or reject." }, { status: 400 });
    if (guard.role !== "hr" && guard.role !== "super_admin") return NextResponse.json({ error: "HR approves substitutions." }, { status: 403 });
    // A system proposal: HR picks the teacher from the suggestions (the same rules as Part C).
    let substituteId = row.substitute_id;
    // The class periods the substitute really covers (1 up to the proposal's; the weekly cap counts these).
    let periods = Number(row.periods);
    if (action === "approve" && !substituteId) {
      substituteId = String(body.substitute_id || "");
      if (!UUID.test(substituteId)) return NextResponse.json({ error: "Pick the substitute teacher." }, { status: 400 });
      if (body.periods !== undefined) {
        const n = Number(body.periods);
        if (!Number.isInteger(n) || n < 1 || n > Number(row.periods)) return NextResponse.json({ error: `The periods covered are 1 to ${row.periods}.` }, { status: 400 });
        periods = n;
      }
      const out = await suggestions(supabase, guard, { absentId: row.absent_employee_id, date: row.sub_date, periods });
      if (out.denied) return out.denied;
      if (out.error) return NextResponse.json({ error: out.error }, { status: 404 });
      if (!out.suggestions.some((x) => x.id === substituteId)) {
        return NextResponse.json({ error: `That teacher cannot substitute here: same level and branch, tapped in that day, not on leave, and at most ${out.cap} periods a week.` }, { status: 400 });
      }
    }
    if (String(substituteId) === String(guard.userId)) return NextResponse.json({ error: "Your own substitution is decided by another HR account." }, { status: 403 });
    const remark = await resolveRemark(supabase, body.remark, { decision: action, entityType: "substitution", fallbackText: body.note });
    if (remark.error) return NextResponse.json({ error: remark.error, code: "remark_invalid" }, { status: 400 });
    const decider = remarkClient(remark, { decision: action, entityType: "substitution", module: "payroll", table: "substitutions", ids: [id], actor: guard });
    const { data, error } = await decider.from("substitutions").update({
      status: action === "approve" ? "approved" : "rejected", ...(action === "approve" ? { substitute_id: substituteId, periods } : {}), decided_by: guard.userId, decided_by_name: by, decided_at: now, decision_note: remark.text || null, updated_at: now,
    }).eq("id", id).eq("status", "pending").select(COLUMNS).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "This substitution was decided at the same time. Refresh." }, { status: 409 });
    await appendAuditLog({ actor: guard, module: "payroll", action: `substitution_${data.status}`, entity_type: "substitution", entity_id: id, branch_id: row.branch_id,
      description: `Substitution on ${row.sub_date} ${row.start_time}-${row.end_time} ${data.status} by ${by}${remark.text ? `: ${remark.text}` : ""}.` });
    return NextResponse.json({ substitution: data });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
