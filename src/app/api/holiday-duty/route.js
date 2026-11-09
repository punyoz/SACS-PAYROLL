import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { scopeFor, SCOPE_ALL, SCOPE_BRANCH, SCOPE_SELF } from "@/lib/rbac/permissions";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { collapseDailyTaps } from "@/lib/attendance/taps";
import { HOLIDAY_TYPE_LABELS, holidayAppliesTo, holidayBadgeLabel, isDayOff, isValidDateKey, shapeHolidayRow } from "@/lib/attendance/holidays";
import { ASSIGN_VIA, DUTY_NOTE_MAX, WORK_DECISIONS, dutyHours, validateDutyInput } from "@/lib/attendance/holiday-duty";
import { manilaDateKey } from "@/lib/payroll/periods";
import { notify } from "@/lib/branch-requests-server";

/**
 * Holiday duty (20261102010000): who HR requires to report on a holiday.
 *
 *   GET  ?year=YYYY          the year's holidays with the number assigned
 *        ?date=YYYY-MM-DD    one holiday: assignments, holiday work without an
 *                            assignment (with HR's decision), assigned
 *                            no-shows, the history, and (HR) who can be assigned
 *        ?mine=1             the signed-in employee's own duty from today on
 *   POST { action: "assign", holiday_date, employee_ids | branch_id | position,
 *          shift_start?, shift_end?, required_hours?, note? }
 *          Without times each person keeps their own normal shift. A person
 *          already assigned that day is left as they are (edit them instead).
 *        { action: "review", holiday_date, employee_id, decision, note? }
 *          a holiday worked without an assignment: approved = paid the premium.
 *   PATCH { id, shift_start, shift_end, required_hours?, note? }   one person
 *   DELETE ?id=…                                                     one person
 *
 * Reading follows attendance: HR and Super Admin every branch, an
 * Accountant their branch, an Employee their own duty. Only HR changes
 * anything, checked here on the server. Every change is written to
 * holiday_duty_history (who, whom, what) and the audit log, and the employee
 * is notified in the system.
 */

const DUTY_COLUMNS = "id,holiday_date,employee_id,branch_id,shift_start,shift_end,required_hours,note,assigned_via,assigned_by_name,created_at,updated_at,updated_by_name";

const json = (body, status = 200) => NextResponse.json(body, { status });
const time5 = (value) => (value ? String(value).slice(0, 5) : null);
const minutesToTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function isHr(guard) {
  return guard.role === "hr";
}

async function readHoliday(supabase, date) {
  const result = await supabase.from("attendance_holidays").select("holiday_date,name,type,day_part,cutoff,branch_ids,source").eq("holiday_date", date).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data ? { date, ...shapeHolidayRow(result.data) } : null;
}

function describeHoliday(holiday) {
  return {
    date: holiday.date,
    name: holiday.name,
    type: holiday.type,
    type_label: HOLIDAY_TYPE_LABELS[holiday.type] || "Holiday",
    label: holidayBadgeLabel(holiday),
    branch_ids: holiday.branch_ids,
    source: holiday.source,
    // Duty can be assigned on a whole day off only (not a special working day).
    assignable: isDayOff(holiday),
  };
}

async function roster(supabase) {
  const result = await fetchAllRows(() => supabase.from("profiles")
    .select("id,full_name,employee_id,branch_id,position,role,archived,employee_status")
    .order("full_name", { ascending: true }));
  if (result.error) throw new Error(result.error.message);
  return (result.data || []).filter((p) => ["employee", "accountant", "hr"].includes(String(p.role || "").toLowerCase())
    && p.archived !== true && String(p.employee_status || "active").toLowerCase() !== "inactive");
}

async function branchNames(supabase) {
  const result = await supabase.from("branches").select("id,name");
  return new Map((result.data || []).map((b) => [b.id, b.name]));
}

/** The normal shift of one employee on a day: { start, end, hours }. */
async function normalShift(supabase, employee, date) {
  const result = await supabase.rpc("attendance_schedule_for", { p_employee: employee.id, p_branch: employee.branch_id || null, p_day: date });
  const row = result.error ? null : (Array.isArray(result.data) ? result.data[0] : result.data);
  if (!row || row.work_start === null || row.work_end === null) return { start: "08:00", end: "17:00", hours: 8 };
  return { start: minutesToTime(Number(row.work_start)), end: minutesToTime(Number(row.work_end)), hours: Number(row.work_hours) || 8 };
}

/** The audit log entry for a change (who did what to whom). */
async function audit(guard, action, entityId, description) {
  await appendAuditLog({
    actor: guard, module: "attendance", action, entity_type: "holiday_duty", entity_id: String(entityId || ""), description,
  }).catch(() => {});
}

async function history(supabase, entry) {
  await supabase.from("holiday_duty_history").insert(entry);
}

/** The day's taps, one row per employee. */
async function dayLogs(supabase, date) {
  const result = await supabase.from("attendance_logs")
    .select("id,employee_id,employee_name,time_in,time_out,status,branch_id,log_date")
    .eq("log_date", date).eq("archived_duplicate", false);
  if (result.error) throw new Error(result.error.message);
  return new Map(collapseDailyTaps(result.data || [], { dateKey: () => date }).map((row) => [String(row.employee_id), row]));
}

async function getYear(supabase, guard, year) {
  const [holidays, duty] = await Promise.all([
    supabase.from("attendance_holidays").select("holiday_date,name,type,day_part,cutoff,branch_ids,source")
      .gte("holiday_date", `${year}-01-01`).lte("holiday_date", `${year}-12-31`).order("holiday_date", { ascending: true }),
    supabase.from("holiday_duty_assignments").select("holiday_date,branch_id")
      .gte("holiday_date", `${year}-01-01`).lte("holiday_date", `${year}-12-31`),
  ]);
  if (holidays.error) throw new Error(holidays.error.message);
  if (duty.error) throw new Error(duty.error.message);
  const branchScoped = scopeFor(guard.role, "attendance") === SCOPE_BRANCH && !guard.branchExempt;
  const counts = new Map();
  (duty.data || []).filter((d) => !branchScoped || d.branch_id === guard.branchId)
    .forEach((d) => counts.set(String(d.holiday_date).slice(0, 10), (counts.get(String(d.holiday_date).slice(0, 10)) || 0) + 1));
  const rows = (holidays.data || [])
    .map((row) => ({ date: String(row.holiday_date).slice(0, 10), ...shapeHolidayRow(row) }))
    .filter((h) => !branchScoped || holidayAppliesTo(h, guard.branchId))
    .map((h) => ({ ...describeHoliday(h), day_part: h.day_part, assigned: counts.get(h.date) || 0 }));
  return { year, today: manilaDateKey(), holidays: rows, can_assign: isHr(guard) };
}

async function getDay(supabase, guard, date) {
  const holiday = await readHoliday(supabase, date);
  if (!holiday) return json({ error: "That date is not a holiday." }, 404);
  const branchScoped = scopeFor(guard.role, "attendance") === SCOPE_BRANCH && !guard.branchExempt;
  const [assignments, reviews, logs, people, branches, log] = await Promise.all([
    supabase.from("holiday_duty_assignments").select(DUTY_COLUMNS).eq("holiday_date", date),
    supabase.from("holiday_work_reviews").select("employee_id,decision,note,decided_by_name,decided_at").eq("holiday_date", date),
    dayLogs(supabase, date),
    roster(supabase),
    branchNames(supabase),
    supabase.from("holiday_duty_history").select("employee_name,action,details,actor_name,created_at").eq("holiday_date", date).order("created_at", { ascending: false }).limit(100),
  ]);
  if (assignments.error) throw new Error(assignments.error.message);
  const peopleById = new Map(people.map((p) => [String(p.id), p]));
  const inScope = (branchId) => !branchScoped || branchId === guard.branchId;
  const today = manilaDateKey();
  const reviewBy = new Map((reviews.data || []).map((r) => [String(r.employee_id), r]));
  const assignedIds = new Set();

  const assigned = (assignments.data || []).filter((a) => inScope(a.branch_id)).map((a) => {
    const person = peopleById.get(String(a.employee_id));
    const tap = logs.get(String(a.employee_id));
    assignedIds.add(String(a.employee_id));
    return {
      id: a.id,
      employee_id: a.employee_id,
      employee_name: person?.full_name || tap?.employee_name || "Employee",
      employee_code: person?.employee_id || null,
      position: person?.position || null,
      branch_name: branches.get(a.branch_id) || "—",
      shift_start: time5(a.shift_start),
      shift_end: time5(a.shift_end),
      required_hours: Number(a.required_hours),
      note: a.note || null,
      assigned_via: a.assigned_via,
      assigned_by_name: a.assigned_by_name,
      updated_by_name: a.updated_by_name,
      time_in: tap?.time_in || null,
      time_out: tap?.time_out || null,
      // Assigned, the day is over, no tap: HR decides (never deducted by itself).
      no_show: date < today && !tap?.time_in,
    };
  }).sort((x, y) => x.employee_name.localeCompare(y.employee_name));

  // Worked the holiday without an assignment: HR approves it as holiday work.
  const unassigned = isDayOff(holiday)
    ? [...logs.values()].filter((row) => row.time_in && !assignedIds.has(String(row.employee_id)) && inScope(row.branch_id)
      && holidayAppliesTo(holiday, row.branch_id)).map((row) => {
      const review = reviewBy.get(String(row.employee_id));
      return {
        employee_id: row.employee_id,
        employee_name: peopleById.get(String(row.employee_id))?.full_name || row.employee_name || "Employee",
        branch_name: branches.get(row.branch_id) || "—",
        time_in: row.time_in,
        time_out: row.time_out,
        log_id: row.id || null,
        decision: review?.decision || "pending",
        note: review?.note || null,
        decided_by_name: review?.decided_by_name || null,
      };
    })
    : [];

  const body = {
    holiday: describeHoliday(holiday),
    today,
    assigned,
    unassigned_work: unassigned,
    history: log.error ? [] : log.data || [],
    can_assign: isHr(guard) && isDayOff(holiday),
  };
  // HR's pickers: the people this holiday applies to, and the groups.
  if (isHr(guard)) {
    const eligible = people.filter((p) => holidayAppliesTo(holiday, p.branch_id));
    body.candidates = eligible.map((p) => ({
      id: p.id, full_name: p.full_name, employee_code: p.employee_id || null, position: p.position || null,
      branch_id: p.branch_id, branch_name: branches.get(p.branch_id) || "—", assigned: assignedIds.has(String(p.id)),
    }));
    body.branches = [...new Set(eligible.map((p) => p.branch_id).filter(Boolean))].map((id) => ({ id, name: branches.get(id) || "—" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    body.positions = [...new Set(eligible.map((p) => normalizeText(p.position)).filter(Boolean))].sort();
  }
  return json(body);
}

async function getMine(supabase, guard) {
  const today = manilaDateKey();
  const result = await supabase.from("holiday_duty_assignments")
    .select("holiday_date,shift_start,shift_end,required_hours,note,assigned_by_name")
    .eq("employee_id", guard.userId).gte("holiday_date", today).order("holiday_date", { ascending: true }).limit(20);
  if (result.error) throw new Error(result.error.message);
  const dates = (result.data || []).map((d) => String(d.holiday_date).slice(0, 10));
  const names = dates.length
    ? new Map(((await supabase.from("attendance_holidays").select("holiday_date,name,type").in("holiday_date", dates)).data || [])
      .map((h) => [String(h.holiday_date).slice(0, 10), h]))
    : new Map();
  return json({
    duty: (result.data || []).map((d) => {
      const key = String(d.holiday_date).slice(0, 10);
      const h = names.get(key);
      return {
        date: key,
        holiday_name: h?.name || "Holiday",
        holiday_label: h ? holidayBadgeLabel(shapeHolidayRow(h)) : "Holiday",
        shift_start: time5(d.shift_start),
        shift_end: time5(d.shift_end),
        required_hours: Number(d.required_hours),
        note: d.note || null,
        assigned_by_name: d.assigned_by_name || null,
      };
    }),
  });
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "attendance", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const url = new URL(request.url);
    const scope = scopeFor(guard.role, "attendance");

    if (url.searchParams.get("mine") === "1" || scope === SCOPE_SELF) return getMine(supabase, guard);
    if (scope !== SCOPE_ALL && scope !== SCOPE_BRANCH && !guard.branchExempt) return json({ error: "You cannot view holiday duty." }, 403);

    const date = String(url.searchParams.get("date") || "");
    if (date) {
      if (!isValidDateKey(date)) return json({ error: "Choose a valid date." }, 400);
      return getDay(supabase, guard, date);
    }
    const year = Number(url.searchParams.get("year")) || Number(manilaDateKey().slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return json({ error: "Choose a year between 2000 and 2100." }, 400);
    return json(await getYear(supabase, guard, year));
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}

/** The signed-in HR officer, or a 403 response. */
async function requireHr(request) {
  const guard = await requirePermission(request, "attendance", "update");
  if (guard.denied) return { denied: guard.denied };
  if (!isHr(guard)) return { denied: json({ error: "Only HR can assign or change holiday duty." }, 403) };
  const supabase = getAdminClient();
  const me = await supabase.from("profiles").select("full_name").eq("id", guard.userId).maybeSingle();
  return { guard, supabase, actorName: me.data?.full_name || "HR" };
}

function shiftLabel(start, end) {
  return `${start}-${end}`;
}

export async function POST(request) {
  try {
    const hr = await requireHr(request);
    if (hr.denied) return hr.denied;
    const { guard, supabase, actorName } = hr;
    const body = await request.json().catch(() => ({}));
    const date = String(body.holiday_date || "");
    if (!isValidDateKey(date)) return json({ error: "Choose the holiday." }, 400);
    const holiday = await readHoliday(supabase, date);
    if (!holiday) return json({ error: "That date is not a holiday." }, 404);

    if (body.action === "review") {
      const decision = String(body.decision || "");
      if (!WORK_DECISIONS.includes(decision)) return json({ error: "Choose approve or reject." }, 400);
      const note = body.note ? String(body.note).trim() : null;
      if (note && note.length > DUTY_NOTE_MAX) return json({ error: `The note can be at most ${DUTY_NOTE_MAX} characters.` }, 400);
      const employeeId = String(body.employee_id || "");
      const logs = await dayLogs(supabase, date);
      const tap = logs.get(employeeId);
      if (!tap?.time_in) return json({ error: "That employee has no tap on this holiday." }, 400);
      const assigned = await supabase.from("holiday_duty_assignments").select("id").eq("holiday_date", date).eq("employee_id", employeeId).maybeSingle();
      if (assigned.data) return json({ error: "This employee was assigned: their holiday work is paid without a review." }, 400);
      const saved = await supabase.from("holiday_work_reviews").upsert({
        holiday_date: date, employee_id: employeeId, log_id: tap.id || null, decision, note,
        decided_by: guard.userId, decided_by_name: actorName, decided_at: new Date().toISOString(),
      }, { onConflict: "holiday_date,employee_id" });
      if (saved.error) throw new Error(saved.error.message);
      const name = tap.employee_name || "Employee";
      await history(supabase, { holiday_date: date, employee_id: employeeId, employee_name: name, action: decision === "approved" ? "work_approved" : "work_rejected", details: { note }, actor_id: guard.userId, actor_name: actorName });
      await audit(guard, `holiday_work_${decision}`, employeeId, `${name}'s work on ${holiday.name} (${date}) ${decision} as holiday work${note ? `: ${note}` : ""}.`);
      await notify(supabase, [employeeId], {
        kind: "holiday_work_review",
        title: decision === "approved" ? `Your work on ${holiday.name} was approved as holiday work` : `Your work on ${holiday.name} was not approved as holiday work`,
        body: note || null, link_page: "emp-timesheet",
      });
      return json({ ok: true });
    }

    if (body.action !== "assign") return json({ error: "Unknown action." }, 400);
    if (!isDayOff(holiday)) return json({ error: "Duty can be assigned on a holiday the school is closed only (not a special working day or a part-day suspension)." }, 400);

    const via = body.branch_id ? "branch" : body.position ? "position" : "employee";
    if (!ASSIGN_VIA.includes(via)) return json({ error: "Choose employees, a branch or a position." }, 400);
    const custom = Boolean(body.shift_start || body.shift_end);
    if (custom) {
      const invalid = validateDutyInput(body);
      if (invalid) return json({ error: invalid }, 400);
    } else if (body.note && String(body.note).length > DUTY_NOTE_MAX) {
      return json({ error: `The note can be at most ${DUTY_NOTE_MAX} characters.` }, 400);
    }

    const people = (await roster(supabase)).filter((p) => holidayAppliesTo(holiday, p.branch_id));
    let chosen;
    if (via === "branch") chosen = people.filter((p) => p.branch_id === body.branch_id);
    else if (via === "position") chosen = people.filter((p) => normalizeText(p.position) === normalizeText(body.position));
    else {
      const ids = new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).map(String));
      chosen = people.filter((p) => ids.has(String(p.id)));
      if (ids.size && chosen.length < ids.size) return json({ error: "Some of the chosen people cannot be assigned (inactive, archived, or the holiday is not theirs)." }, 400);
    }
    if (!chosen.length) return json({ error: "Nobody to assign: choose at least one employee." }, 400);

    const existing = await supabase.from("holiday_duty_assignments").select("employee_id").eq("holiday_date", date);
    if (existing.error) throw new Error(existing.error.message);
    const already = new Set((existing.data || []).map((r) => String(r.employee_id)));
    const fresh = chosen.filter((p) => !already.has(String(p.id)));
    const note = body.note ? String(body.note).trim() || null : null;
    const rows = await Promise.all(fresh.map(async (p) => {
      const normal = custom ? null : await normalShift(supabase, p, date);
      const start = custom ? String(body.shift_start).slice(0, 5) : normal.start;
      const end = custom ? String(body.shift_end).slice(0, 5) : normal.end;
      const hours = custom
        ? (body.required_hours !== undefined && body.required_hours !== null && body.required_hours !== "" ? Number(body.required_hours) : dutyHours(start, end))
        : normal.hours;
      return {
        holiday_date: date, employee_id: p.id, branch_id: p.branch_id || null, shift_start: start, shift_end: end,
        required_hours: Math.min(12, Math.max(0.25, Math.round(hours * 100) / 100)), note, assigned_via: via,
        assigned_by: guard.userId, assigned_by_name: actorName,
      };
    }));
    if (rows.length) {
      const inserted = await supabase.from("holiday_duty_assignments").insert(rows);
      if (inserted.error) throw new Error(inserted.error.message);
      await supabase.from("holiday_duty_history").insert(rows.map((r) => ({
        holiday_date: date, employee_id: r.employee_id, employee_name: chosen.find((p) => p.id === r.employee_id)?.full_name || null,
        action: "assigned", details: { shift: shiftLabel(r.shift_start, r.shift_end), required_hours: r.required_hours, note, via }, actor_id: guard.userId, actor_name: actorName,
      })));
      await audit(guard, "holiday_duty_assigned", date, `${rows.length} assigned to report on ${holiday.name} (${date}), by ${via}.`);
      await notify(supabase, rows.map((r) => r.employee_id), {
        kind: "holiday_duty",
        title: `You are required to report on ${holiday.name} (${date})`,
        body: `Holiday duty ${rows[0].shift_start}-${rows[0].shift_end}${note ? ` · ${note}` : ""}. Assigned by ${actorName}.`,
        link_page: "emp-timesheet",
      });
    }
    return json({ ok: true, assigned: rows.length, skipped: chosen.length - rows.length });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}

export async function PATCH(request) {
  try {
    const hr = await requireHr(request);
    if (hr.denied) return hr.denied;
    const { guard, supabase, actorName } = hr;
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const found = await supabase.from("holiday_duty_assignments").select(DUTY_COLUMNS).eq("id", id).maybeSingle();
    if (found.error || !found.data) return json({ error: "That assignment was not found." }, 404);
    const invalid = validateDutyInput(body);
    if (invalid) return json({ error: invalid }, 400);
    const start = String(body.shift_start).slice(0, 5);
    const end = String(body.shift_end).slice(0, 5);
    const hours = body.required_hours !== undefined && body.required_hours !== null && body.required_hours !== "" ? Number(body.required_hours) : dutyHours(start, end);
    const note = body.note ? String(body.note).trim() || null : null;
    const updated = await supabase.from("holiday_duty_assignments").update({
      shift_start: start, shift_end: end, required_hours: Math.round(hours * 100) / 100, note,
      updated_at: new Date().toISOString(), updated_by: guard.userId, updated_by_name: actorName,
    }).eq("id", id);
    if (updated.error) throw new Error(updated.error.message);
    const before = found.data;
    const date = String(before.holiday_date).slice(0, 10);
    const person = await supabase.from("profiles").select("full_name").eq("id", before.employee_id).maybeSingle();
    await history(supabase, {
      assignment_id: id, holiday_date: date, employee_id: before.employee_id, employee_name: person.data?.full_name || null, action: "changed",
      details: { from: { shift: shiftLabel(time5(before.shift_start), time5(before.shift_end)), required_hours: Number(before.required_hours), note: before.note }, to: { shift: shiftLabel(start, end), required_hours: hours, note } },
      actor_id: guard.userId, actor_name: actorName,
    });
    await audit(guard, "holiday_duty_changed", before.employee_id, `${person.data?.full_name || "Employee"}'s duty on ${date} changed to ${shiftLabel(start, end)}.`);
    await notify(supabase, [before.employee_id], {
      kind: "holiday_duty", title: `Your holiday duty on ${date} was changed`, body: `Now ${start}-${end}${note ? ` · ${note}` : ""}.`, link_page: "emp-timesheet",
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}

export async function DELETE(request) {
  try {
    const hr = await requireHr(request);
    if (hr.denied) return hr.denied;
    const { guard, supabase, actorName } = hr;
    const id = String(new URL(request.url).searchParams.get("id") || "");
    const found = await supabase.from("holiday_duty_assignments").select(DUTY_COLUMNS).eq("id", id).maybeSingle();
    if (found.error || !found.data) return json({ error: "That assignment was not found." }, 404);
    const removed = await supabase.from("holiday_duty_assignments").delete().eq("id", id);
    if (removed.error) throw new Error(removed.error.message);
    const row = found.data;
    const date = String(row.holiday_date).slice(0, 10);
    const person = await supabase.from("profiles").select("full_name").eq("id", row.employee_id).maybeSingle();
    await history(supabase, {
      assignment_id: id, holiday_date: date, employee_id: row.employee_id, employee_name: person.data?.full_name || null, action: "removed",
      details: { shift: shiftLabel(time5(row.shift_start), time5(row.shift_end)), note: row.note }, actor_id: guard.userId, actor_name: actorName,
    });
    await audit(guard, "holiday_duty_removed", row.employee_id, `${person.data?.full_name || "Employee"}'s duty on ${date} removed.`);
    await notify(supabase, [row.employee_id], {
      kind: "holiday_duty", title: `You no longer need to report on ${date}`, body: `Holiday duty removed by ${actorName}.`, link_page: "emp-timesheet",
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: sanitizeError(error) }, 500);
  }
}
