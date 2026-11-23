/**
 * Part E step 4 (2026-11-23): leave recommendations. The system fills the
 * branch Admin's recommendation from four checks; the Admin checks it (Note /
 * Object on the Automation card, or their own Endorse / Not endorse), and with
 * no objection it goes to HR by itself. HR approves or rejects as always.
 *
 *   credits   the type's paid days left vs the days asked (over: the extra
 *             days become without pay at approval, as decided 2026-11-12)
 *   filing    filed at least LEAVE_ADVANCE_DAYS before (a half day has its own window)
 *   calendar  holidays inside the range (not counted as leave days)
 *   staffing  per date: scheduled staff minus those on leave, against
 *             automation.min_staff_present_pct (a warning only)
 *
 * After HR approves: the days are On Leave and the credits used (the database
 * and applyBalanceSplit do that); it is logged "by System", and for a teacher
 * the branch Admin gets a substitution proposal for the days (Part C arranges).
 */
import { LEAVE_ADVANCE_DAYS } from "@/lib/leave-requests/advance-rule";
import { splitForBalance } from "@/lib/leave-requests/split";
import { leaveBalancesFor } from "@/lib/leave-requests/store";

const dayKey = (v) => String(v || "").slice(0, 10);
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const short = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The working days in a range (weekdays; the holidays are checked separately). */
export function rangeDays(start, end) {
  const out = [];
  for (let d = dayKey(start); d <= dayKey(end || start); d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
    if (out.length > 60) break;
  }
  return out;
}

/** Pure part (tested): the recommendation from the checks' facts. */
export function recommendFrom({ leave, remaining, filedKey, holidays = [], staffing = [] }) {
  const reasons = [];
  const warnings = [];
  const split = leave.pay_status === "with_pay" ? splitForBalance(leave, remaining) : null;
  if (split && split.without_pay_days > 0) warnings.push(`Credits: ${remaining} paid day${remaining === 1 ? "" : "s"} left; ${split.without_pay_days} day${split.without_pay_days === 1 ? "" : "s"} would be without pay`);
  else reasons.push(leave.pay_status === "with_pay" ? `Credits: enough (${remaining} paid day${remaining === 1 ? "" : "s"} left)` : "Without pay: no credits used");
  const ahead = Math.round((Date.parse(`${dayKey(leave.start_date)}T00:00:00Z`) - Date.parse(`${filedKey}T00:00:00Z`)) / 864e5);
  if (leave.half_day) reasons.push("Half day: its own filing window");
  else if (ahead >= LEAVE_ADVANCE_DAYS) reasons.push(`Filed ${ahead} days ahead (rule: ${LEAVE_ADVANCE_DAYS})`);
  else warnings.push(ahead < 0 ? `Filed ${-ahead} day${-ahead === 1 ? "" : "s"} after it started` : `Filed ${ahead} day${ahead === 1 ? "" : "s"} ahead (rule: ${LEAVE_ADVANCE_DAYS})`);
  if (holidays.length) reasons.push(`Calendar: ${holidays.length} holiday${holidays.length === 1 ? "" : "s"} in the range (${holidays.map(short).join(", ")}), not counted`);
  const low = staffing.filter((s) => s.below);
  if (low.length) warnings.push(`Staffing below ${low[0].min_pct}% on ${low.map((s) => `${short(s.date)} (${s.pct}%)`).join(", ")}`);
  else if (staffing.length) reasons.push(`Staffing: at least ${Math.min(...staffing.map((s) => s.pct))}% present every day`);
  return {
    decision: "endorse",
    label: warnings.length ? "Recommend approval, with warnings" : "Recommend approval",
    reasons, warnings, split,
  };
}

/** The facts for a leave request, then the recommendation. */
export async function recommendLeave(supabase, leave) {
  const start = dayKey(leave.start_date);
  const end = dayKey(leave.end_date || leave.start_date);
  const [balances, { data: holidays }, profile] = await Promise.all([
    leaveBalancesFor([leave.employee_id]),
    supabase.from("attendance_holidays").select("holiday_date,day_part,type").gte("holiday_date", start).lte("holiday_date", end),
    supabase.from("profiles").select("branch_id,employee_type").eq("id", leave.employee_id).maybeSingle(),
  ]);
  const bal = balances?.[leave.employee_id];
  const remaining = Number(bal?.by_type?.[leave.leave_type]?.remaining ?? bal?.with_pay_remaining ?? 0) || 0;
  const holidayKeys = (holidays || []).filter((h) => h.day_part === "whole" && h.type !== "special_working").map((h) => dayKey(h.holiday_date));
  const branchId = leave.branch_id || profile.data?.branch_id || null;
  const days = rangeDays(start, end).filter((d) => !holidayKeys.includes(d));
  const staffing = branchId ? await Promise.all(days.map(async (d) => (await supabase.rpc("automation_leave_staffing", { p_branch: branchId, p_day: d })).data).filter(Boolean)) : [];
  const filedKey = dayKey(leave.submitted_at || leave.created_at || new Date().toISOString());
  return { ...recommendFrom({ leave, remaining, filedKey, holidays: holidayKeys, staffing: staffing.filter(Boolean) }), branch_id: branchId, teaching: String(profile.data?.employee_type || "").toLowerCase() === "teaching", days };
}

/** Log it for the branch Admin's check (once per leave request). Never throws. */
export async function logLeaveRecommendation(supabase, leave) {
  try {
    const existing = await supabase.from("automation_actions").select("id").eq("module", "leave_recommendations").eq("entity_type", "leave_request").eq("entity_id", String(leave.id)).limit(1);
    if ((existing.data || []).length) return null;
    const rec = await recommendLeave(supabase, leave);
    const { data } = await supabase.rpc("automation_log", {
      p_module: "leave_recommendations", p_rule: "credits, filing time, calendar and minimum staffing",
      p_kind: "proposal", p_summary: `${leave.employee_name}: ${leave.leave_type}, ${dayKey(leave.start_date)} to ${dayKey(leave.end_date || leave.start_date)}. ${rec.label}`,
      p_data: { leave_id: leave.id, decision: rec.decision, label: rec.label, reasons: rec.reasons, warnings: rec.warnings, split: rec.split },
      p_employee: leave.employee_id, p_branch: rec.branch_id, p_entity_type: "leave_request", p_entity_id: String(leave.id),
      p_effective_on: dayKey(leave.start_date),
    });
    return data || null;
  } catch {
    return null;
  }
}

/** The system's recommendations for these leave requests (for the Admin's and HR's lists). */
export async function recommendationsFor(supabase, leaveIds) {
  const ids = [...new Set((leaveIds || []).map(String))];
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from("automation_actions").select("entity_id,status,data,admin_note,admin_objected,admin_noted_by_name")
      .eq("module", "leave_recommendations").eq("entity_type", "leave_request").in("entity_id", ids.slice(i, i + 100));
    for (const r of data || []) out.set(r.entity_id, { status: r.status, label: r.data?.label, reasons: r.data?.reasons || [], warnings: r.data?.warnings || [],
      admin_note: r.admin_note, admin_objected: r.admin_objected, admin_noted_by_name: r.admin_noted_by_name });
  }
  return out;
}

/** HR decided: close the recommendation; after an approval, log what the system did and propose substitutes for a teacher. */
export async function afterLeaveDecision(supabase, leave, decision) {
  try {
    const { data: rec } = await supabase.from("automation_actions").select("id").eq("module", "leave_recommendations").eq("entity_type", "leave_request").eq("entity_id", String(leave.id)).maybeSingle();
    if (rec?.id) await supabase.rpc("automation_close", { p_id: rec.id, p_note: `HR ${decision === "approve" ? "approved" : "rejected"} it` });
    if (decision !== "approve") return;
    const facts = await recommendLeave(supabase, leave);
    await supabase.rpc("automation_log", {
      p_module: "leave_recommendations", p_rule: "approved leave: the days marked On Leave and the credits used",
      p_kind: "applied", p_summary: `${leave.employee_name}: ${facts.days.length} day${facts.days.length === 1 ? "" : "s"} On Leave (${dayKey(leave.start_date)} to ${dayKey(leave.end_date || leave.start_date)})`,
      p_data: { leave_id: leave.id, days: facts.days, split: facts.split }, p_employee: leave.employee_id, p_branch: facts.branch_id,
      p_entity_type: "leave_request_applied", p_entity_id: String(leave.id),
    });
    if (facts.teaching && facts.days.length && !leave.half_day) {
      await supabase.rpc("automation_log", {
        p_module: "leave_recommendations", p_rule: "a teacher on approved leave: arrange a substitute (Part C suggestions)",
        p_kind: "proposal", p_summary: `Arrange a substitute for ${leave.employee_name} on ${facts.days.map(short).join(", ")}`,
        p_data: { leave_id: leave.id, days: facts.days, absent_id: leave.employee_id }, p_employee: leave.employee_id, p_branch: facts.branch_id,
        p_entity_type: "substitution_proposal", p_entity_id: String(leave.id), p_effective_on: facts.days[0],
      });
    }
  } catch { /* never fails the decision */ }
}
