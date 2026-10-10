/**
 * AWOL cases (docs/payroll-schedule-loans-awol.md §5; employee_awol_cases,
 * 20261009010000). The nightly job opens a case at 3 consecutive unexcused
 * working-day absences; HR confirms and sends the two notices; the branch
 * Admin decides separation (Approvals).
 *
 *   flagged ──confirm──► confirmed ──1st notice──► first_notice
 *     ──2nd notice──► second_notice ──recommend──► for_decision
 *     ──Admin approves──► closed (separated)   ──Admin returns──► second_notice
 *   any open stage ──close──► closed (false_alarm | returned | excused_by_leave)
 *
 * Confirming sets the employee to AWOL (the database then holds pay);
 * closing as returned / excused / false alarm sets them back to Active (pay
 * released); separation sets Separated (pay only through final pay). Every
 * status change is written to profiles AND the account's metadata (both are
 * read by the portals) and logged in employee_status_changes.
 */

import { normalizeText } from "@/lib/auth/normalize";
import { invalidateUsersCache } from "@/lib/auth/users-cache";

export const OPEN_STAGES = Object.freeze(["flagged", "confirmed", "first_notice", "second_notice", "for_decision"]);
export const STAGE_LABELS = Object.freeze({
  flagged: "Flagged",
  confirmed: "Confirmed AWOL",
  first_notice: "1st notice sent",
  second_notice: "2nd notice sent",
  for_decision: "Waiting for Admin",
  closed: "Closed",
});
export const OUTCOME_LABELS = Object.freeze({
  false_alarm: "False alarm",
  returned: "Returned to work",
  excused_by_leave: "Excused by leave",
  separated: "Separated",
});
export const REPLY_DAYS = 5;

/** Which stage an action may start from, and where it goes. */
export const TRANSITIONS = Object.freeze({
  confirm: { from: ["flagged"], to: "confirmed" },
  first_notice: { from: ["confirmed"], to: "first_notice" },
  second_notice: { from: ["first_notice"], to: "second_notice" },
  recommend: { from: ["second_notice"], to: "for_decision" },
  approve_separation: { from: ["for_decision"], to: "closed" },
  return_to_hr: { from: ["for_decision"], to: "second_notice" },
  close: { from: ["flagged", "confirmed", "first_notice", "second_notice", "for_decision"], to: "closed" },
  record_reply: { from: ["confirmed", "first_notice", "second_notice", "for_decision"], to: null },
});

export function canTransition(action, stage) {
  return Boolean(TRANSITIONS[action]?.from.includes(stage));
}

export function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

/**
 * Set an employee's status (Active / AWOL / Separated) in profiles and the
 * account metadata, and log it. profiles_payroll_hold_sync holds / releases
 * pay from the status. Returns an error message, or null.
 */
export async function setEmployeeStatus(supabase, {
  employeeId, status, reason, caseId = null, effectiveOn, actor, extra = {},
}) {
  const current = await supabase.from("profiles").select("employee_status").eq("id", employeeId).maybeSingle();
  if (current.error) return current.error.message;
  const oldStatus = current.data?.employee_status || null;

  const updated = await supabase.from("profiles")
    .update({ employee_status: status, ...extra, updated_at: new Date().toISOString() })
    .eq("id", employeeId);
  if (updated.error) return updated.error.message;

  // The portals also read the account's metadata (src/app/api/admin/employees).
  const user = await supabase.auth.admin.getUserById(employeeId);
  if (!user.error && user.data?.user) {
    const metadata = { ...(user.data.user.user_metadata || {}), employee_status: status, rfid_status: status };
    await supabase.auth.admin.updateUserById(employeeId, { user_metadata: metadata });
    invalidateUsersCache();
  }

  const logged = await supabase.from("employee_status_changes").insert({
    employee_id: employeeId,
    old_status: oldStatus,
    new_status: status,
    effective_on: effectiveOn,
    reason: normalizeText(reason).slice(0, 500) || null,
    awol_case_id: caseId,
    changed_by: actor?.userId || null,
    changed_by_name: normalizeText(actor?.session?.full_name, actor?.session?.email) || null,
  });
  if (logged.error) return logged.error.message;
  return null;
}

/** The case row enriched for screens. */
export function shapeCase(row, person) {
  return {
    ...row,
    employee_name: person?.full_name || "—",
    employee_code: person?.employee_id || "",
    employee_type: person?.employee_type || null,
    employee_status: person?.employee_status || null,
    stage_label: STAGE_LABELS[row.stage] || row.stage,
    outcome_label: row.outcome ? OUTCOME_LABELS[row.outcome] || row.outcome : null,
    open: row.stage !== "closed",
  };
}
