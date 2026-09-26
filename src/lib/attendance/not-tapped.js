/**
 * Who has not tapped in on a working day, as "Absent" rows for display.
 *
 * The nightly close (public.attendance_close_days) writes real Absent records,
 * but only for days that have ended. Until then an attendance page would show
 * only the people who did tap; this fills in everyone else so HR sees today's
 * absentees by name, the way the Admin page always has.
 *
 * Nobody is listed on a rest day or holiday, before their hire date, while
 * archived / inactive, or on a day covered by approved leave. The rows are
 * placeholders (id null, placeholder: true) -- nothing is written.
 */

import { normalizeText } from "@/lib/auth/normalize";

function isWeekend(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

async function isHoliday(supabase, dateKey) {
  try {
    const result = await supabase
      .from("attendance_holidays")
      .select("holiday_date")
      .eq("holiday_date", dateKey)
      .limit(1);
    return !result.error && (result.data || []).length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {object} supabase     service-role client
 * @param {object} args
 * @param {string} args.dateKey "YYYY-MM-DD"
 * @param {Set<string>} args.loggedIds  employee ids that already have a record that day
 * @param {string[]|null} [args.employeeIds]  limit to these (branch scoping); null = everyone
 * @returns {Promise<object[]>} placeholder Absent rows
 */
export async function listNotTapped(supabase, { dateKey, loggedIds, employeeIds = null }) {
  if (!dateKey || isWeekend(dateKey) || await isHoliday(supabase, dateKey)) return [];
  if (Array.isArray(employeeIds) && !employeeIds.length) return [];

  let query = supabase
    .from("profiles")
    .select("id,full_name,employee_type,branch_id,role,archived,employee_status,date_hired,created_at,employee_id")
    .limit(5000);
  if (Array.isArray(employeeIds)) query = query.in("id", employeeIds);
  const roster = await query;
  if (roster.error) return [];

  const people = (roster.data || []).filter((p) => {
    const role = String(p.role || "").toLowerCase();
    if (role !== "employee" && role !== "accountant") return false;
    if (p.archived === true) return false;
    if (String(p.employee_status || "").toLowerCase() === "inactive") return false;
    const hired = String(p.date_hired || p.created_at || "").slice(0, 10);
    if (hired && hired > dateKey) return false;
    return !loggedIds.has(String(p.id));
  });
  if (!people.length) return [];

  // Approved leave covering the day (either id form -- see buildLeaveContext()
  // in the accountant payroll route).
  const onLeave = new Set();
  try {
    const leave = await supabase
      .from("leave_requests")
      .select("employee_id,start_date,end_date,status")
      .eq("status", "approved")
      .lte("start_date", dateKey)
      .gte("end_date", dateKey);
    if (!leave.error) (leave.data || []).forEach((row) => onLeave.add(String(row.employee_id)));
  } catch {
    // Leave unreadable: list everyone rather than hide an absence.
  }

  return people
    .filter((p) => !onLeave.has(String(p.id)) && !onLeave.has(String(p.employee_id || "")))
    .map((p) => ({
      id: null,
      placeholder: true,
      not_yet_tapped: true,
      employee_id: p.id,
      employee_name: normalizeText(p.full_name, "Unknown"),
      employee_type: normalizeText(p.employee_type, "Teaching"),
      branch_id: p.branch_id || null,
      log_date: dateKey,
      date: dateKey,
      time_in: null,
      time_out: null,
      total_hours: 0,
      status: "Absent",
      late_minutes: 0,
      undertime_minutes: 0,
    }));
}
