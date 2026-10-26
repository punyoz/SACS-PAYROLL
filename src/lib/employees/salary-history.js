/**
 * Basic salary changes, effective-dated (public.employee_salary_changes,
 * 20261027010000; decisions of 2026-10-26):
 *
 *   - Only HR records one (POST /api/hr/salary-changes), with an effective
 *     date on the 1st of a month, a reason and an optional note. The database
 *     refuses a row not made by an active HR account.
 *   - Rows are never changed or deleted; a later row for the same date wins.
 *   - Payroll uses the salary in force on each pay period's first day
 *     (salaryOn), so a period before the effective date keeps the old salary
 *     and past payslips never move.
 *   - The employee's current salary (profiles.basic_salary + user_metadata)
 *     becomes the new one on the effective date (applyDueSalaryChanges).
 */

import { roundPeso } from "@/lib/payroll/money";
import { invalidateUsersCache } from "@/lib/auth/users-cache";
import { SALARY_MAX } from "@/lib/employees/record";
import { fetchAllIn, fetchAllRows, forEachInChunk } from "@/lib/supabase/fetch-all";

export const SALARY_REASONS = Object.freeze(["Performance review", "Contract renewal", "Promotion", "Salary adjustment", "Correction", "Other"]);
const COLUMNS = "id,employee_id,old_salary,new_salary,effective_date,reason,note,created_by,created_by_name,created_by_role,created_at,applied_at";

const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const byDateThenCreated = (a, b) => String(a.effective_date).localeCompare(String(b.effective_date))
  || String(a.created_at || "").localeCompare(String(b.created_at || ""));

/**
 * The basic salary in force on dateKey for one employee: the newest change
 * effective on or before it; before the first change, that change's old
 * salary; with no change at all, `current` (the salary on record).
 */
export function salaryOn(rows, employeeId, dateKey, current) {
  const own = (rows || []).filter((row) => String(row.employee_id) === String(employeeId)).sort(byDateThenCreated);
  if (!own.length) return Number(current) || 0;
  const inForce = own.filter((row) => String(row.effective_date) <= String(dateKey));
  if (inForce.length) return Number(inForce.at(-1).new_salary) || 0;
  return Number(own[0].old_salary) || 0;
}

/** The day before a "YYYY-MM-DD" key. */
export function dayBefore(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Checks for a new change. `todayKey` = today in Manila; `settledMonths` =
 * "YYYY-MM" months whose 2nd half is already Final for this employee (their
 * salary can no longer change). Returns an error message, or null.
 */
export function validateSalaryChange({ new_salary: newSalary, effective_date: effectiveDate, reason, note }, { todayKey, settledMonths = [] }) {
  const amount = Number(newSalary);
  if (!(amount > 0) || amount > SALARY_MAX) return "Enter the new monthly salary: more than ₱0 and at most ₱9,999,999.99.";
  if (!isDateKey(effectiveDate)) return "Choose the month the new salary starts.";
  if (String(effectiveDate).slice(8) !== "01") return "A salary change starts on the 1st of a month.";
  if (String(effectiveDate).slice(0, 7) < String(todayKey).slice(0, 7)) return "A salary change cannot start in a past month.";
  if (settledMonths.includes(String(effectiveDate).slice(0, 7))) return "That month's payroll is already Final for this employee. Choose the next month.";
  if (!SALARY_REASONS.includes(reason)) return `Choose the reason: ${SALARY_REASONS.join(", ")}.`;
  if (["Correction", "Other"].includes(reason) && String(note || "").trim().length < 10) return "Explain the change in the note (at least 10 characters).";
  return null;
}

/** Every change of these employees (all when `employeeIds` is null). Never throws: [] before the migration. */
export async function loadSalaryChanges(supabase, employeeIds = null) {
  try {
    const query = () => supabase.from("employee_salary_changes").select(COLUMNS).order("effective_date", { ascending: true }).order("created_at", { ascending: true }).order("id", { ascending: true });
    if (Array.isArray(employeeIds) && !employeeIds.length) return { rows: [], available: true };
    const result = Array.isArray(employeeIds) ? await fetchAllIn(query, "employee_id", employeeIds) : await fetchAllRows(query);
    if (result.error) throw result.error;
    return { rows: result.data || [], available: true };
  } catch (error) {
    return { rows: [], available: false, error: error?.message || String(error) };
  }
}

/**
 * Sets each employee's salary on record to the one in force today, once its
 * effective date has come (applied_at marks it). Payroll never depends on
 * this (it reads the history by period), so a delay only affects what the
 * screens show. Never throws.
 */
export async function applyDueSalaryChanges(supabase, todayKey) {
  try {
    const due = await supabase.from("employee_salary_changes").select(COLUMNS).is("applied_at", null).lte("effective_date", todayKey);
    if (due.error || !(due.data || []).length) return 0;
    const ids = [...new Set(due.data.map((row) => row.employee_id))];
    const all = (await loadSalaryChanges(supabase, ids)).rows;
    let applied = 0;
    for (const id of ids) {
      const salary = roundPeso(salaryOn(all, id, todayKey, 0));
      if (!(salary > 0)) continue;
      const user = await supabase.auth.admin.getUserById(id);
      if (user.error || !user.data?.user) continue;
      const metadata = user.data.user.user_metadata || {};
      const updated = await supabase.auth.admin.updateUserById(id, { user_metadata: { ...metadata, basic_salary: salary } });
      if (updated.error) continue;
      const profile = await supabase.from("profiles").update({ basic_salary: salary }).eq("id", id);
      if (profile.error) continue;
      const rowIds = due.data.filter((row) => row.employee_id === id).map((row) => row.id);
      await forEachInChunk(rowIds, (part) => supabase.from("employee_salary_changes").update({ applied_at: new Date().toISOString() }).in("id", part));
      applied += 1;
    }
    if (applied) invalidateUsersCache();
    return applied;
  } catch {
    return 0;
  }
}

/** A row for the screen: who, when, old → new. */
export function shapeSalaryChange(row) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    old_salary: roundPeso(row.old_salary),
    new_salary: roundPeso(row.new_salary),
    effective_date: row.effective_date,
    reason: row.reason,
    note: row.note || null,
    created_by_name: row.created_by_name || null,
    created_by_role: row.created_by_role || null,
    created_at: row.created_at,
    applied: Boolean(row.applied_at),
  };
}
