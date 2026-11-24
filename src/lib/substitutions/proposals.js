// Substitution proposals (2026-11-24): when a teacher's leave (or half-day
// leave) is approved, the system proposes a substitution for each school day
// of it: the date, the hours of the teacher's schedule that day (the morning
// or afternoon half for a half day) and the periods (one per hour). No
// substitute yet: HR picks one from the Part C suggestions (same level and
// branch, tapped in / not on leave, under the weekly cap) and approves.
// Taps confirm and payroll pays as in Part C. A cancelled leave cancels its
// open proposals. Never fails the leave decision.

const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const dayKey = (v) => String(v || "").slice(0, 10);
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** The covered span of one day: the whole shift, or the half the leave covers. */
export function proposalSpan(schedule, halfDay = null) {
  const start = Number(schedule?.work_start);
  const end = Number(schedule?.work_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const hours = Number(schedule?.work_hours) > 0 ? Number(schedule.work_hours) : (end - start) / 60;
  if (!halfDay) return { start: hhmm(start), end: hhmm(end), periods: Math.max(1, Math.min(10, Math.round(hours))) };
  const mid = start + Math.round((end - start) / 2);
  const span = halfDay === "AM" ? { start: hhmm(start), end: hhmm(mid) } : { start: hhmm(mid), end: hhmm(end) };
  return { ...span, periods: Math.max(1, Math.min(10, Math.round(hours / 2))) };
}

/** The school days of a leave: weekdays the schedule works, not a whole-day holiday. */
export function leaveDays(start, end, holidays = []) {
  const out = [];
  for (let d = dayKey(start); d <= dayKey(end || start); d = addDays(d, 1)) {
    if ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) continue;
    if (holidays.includes(d)) continue;
    out.push(d);
  }
  return out;
}

export async function proposeSubstitutions(supabase, leave) {
  try {
    const { data: teacher } = await supabase.from("profiles").select("id,full_name,branch_id,employee_type").eq("id", leave.employee_id).maybeSingle();
    if (!teacher || String(teacher.employee_type || "").toLowerCase() !== "teaching") return { created: 0 };
    const start = dayKey(leave.start_date);
    const end = dayKey(leave.end_date || leave.start_date);
    const { data: hols } = await supabase.from("attendance_holidays").select("holiday_date,day_part,type").gte("holiday_date", start).lte("holiday_date", end);
    const holidays = (hols || []).filter((h) => h.day_part === "whole" && h.type !== "special_working").map((h) => dayKey(h.holiday_date));
    let created = 0;
    for (const day of leaveDays(start, end, holidays)) {
      const { data: sched } = await supabase.rpc("attendance_schedule_for", { p_employee: teacher.id, p_branch: teacher.branch_id, p_day: day });
      const row = Array.isArray(sched) ? sched[0] : sched;
      const span = proposalSpan(row, leave.half_day === "AM" || leave.half_day === "PM" ? leave.half_day : null);
      if (!span) continue;
      const { error } = await supabase.from("substitutions").insert({
        branch_id: teacher.branch_id, sub_date: day, absent_employee_id: teacher.id, substitute_id: null,
        start_time: span.start, end_time: span.end, periods: span.periods, leave_request_id: String(leave.id),
        status: "pending", source: "leave", created_by: null, created_by_name: "System",
      });
      if (!error) created += 1;
      else if (String(error.code) !== "23505") throw error; // 23505: already proposed for that day
    }
    if (created) {
      await supabase.rpc("automation_log", {
        p_module: "leave_recommendations", p_rule: "a teacher on approved leave: a substitution is proposed for each school day",
        p_kind: "applied", p_summary: `${teacher.full_name}: ${created} substitution${created === 1 ? "" : "s"} proposed (${start}${end !== start ? ` to ${end}` : ""}); HR picks the teacher`,
        p_data: { leave_id: leave.id, created }, p_employee: teacher.id, p_branch: teacher.branch_id,
        p_entity_type: "substitution_proposal", p_entity_id: String(leave.id), p_effective_on: start,
      });
    }
    return { created };
  } catch {
    return { created: 0 };
  }
}

/** A cancelled or withdrawn leave: its open proposals (no substitute decided yet) are cancelled. */
export async function cancelSubstitutionProposals(supabase, leaveId) {
  try {
    await supabase.from("substitutions").update({ status: "cancelled", decision_note: "The leave was cancelled", updated_at: new Date().toISOString() })
      .eq("leave_request_id", String(leaveId)).eq("source", "leave").eq("status", "pending");
  } catch { /* never fails the cancellation */ }
}
