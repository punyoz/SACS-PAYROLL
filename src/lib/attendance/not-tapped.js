/**
 * Who has not tapped in on a working day, as "Absent" rows for display.
 *
 * The nightly close (public.attendance_close_days) writes real Absent records,
 * but only for days that have ended. Until then an attendance page would show
 * only the people who did tap; this fills in everyone else so HR sees today's
 * absentees by name, the way the Admin page always has.
 *
 * Who is missing comes from public.attendance_missing_days, the SAME function
 * the nightly close inserts its Absent records from (20261114010000): role
 * employee / accountant / hr, not archived or inactive, hired by the day, no
 * record, no approved leave, and a working day by that person's own schedule
 * and their branch's holidays. So a card, its list and the records the close
 * writes later always agree. The rows are placeholders (id null,
 * placeholder: true) -- nothing is written.
 */

import { normalizeText } from "@/lib/auth/normalize";

/**
 * @param {object} supabase     service-role client
 * @param {object} args
 * @param {string} args.dateKey "YYYY-MM-DD"
 * @param {Set<string>} [args.loggedIds]  employee ids already shown with a record that day
 * @param {string[]|null} [args.employeeIds]  limit to these (branch scoping); null = everyone
 * @returns {Promise<object[]>} placeholder Absent rows
 */
export async function listNotTapped(supabase, { dateKey, loggedIds = new Set(), employeeIds = null }) {
  if (!dateKey) return [];
  if (Array.isArray(employeeIds) && !employeeIds.length) return [];
  const { data, error } = await supabase.rpc("attendance_missing_days", { p_from: dateKey, p_to: dateKey });
  // Visible, not an empty list: hiding an absence would look like "everyone tapped in".
  if (error) throw new Error(`Could not read who has not tapped in: ${error.message}`);
  const allowed = Array.isArray(employeeIds) ? new Set(employeeIds.map(String)) : null;
  return (data || [])
    .filter((p) => (!allowed || allowed.has(String(p.employee_id))) && !loggedIds.has(String(p.employee_id)))
    .map((p) => ({
      id: null,
      placeholder: true,
      not_yet_tapped: true,
      employee_id: p.employee_id,
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

/**
 * "Absent today" on the dashboards (decision 2026-11-14): the people the
 * boards list as "Not tapped yet" -- the nightly close's own rule, for today.
 * employeeIds: a branch's people, or null for all.
 */
export async function countAbsentToday(supabase, { dateKey, employeeIds = null }) {
  return (await listNotTapped(supabase, { dateKey, employeeIds })).length;
}
