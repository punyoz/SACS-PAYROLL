/**
 * Automation (Part E): what the client and the route share.
 * Statuses mirror 20261124010000_automation_framework.sql.
 */
export const AUTOMATION_STATUSES = Object.freeze(["done", "admin_check", "with_hr", "open", "couldnt_decide", "undone", "closed"]);
export const NOTE_MIN = 3;

/** The automation modules (Part E), each with its own pause (automation.paused_<module>). */
export const AUTOMATION_MODULES = Object.freeze({
  attendance_flags: "Attendance flags",
  schedule_requests: "Schedule requests",
  attendance_corrections: "Attendance correction checks",
  leave_recommendations: "Leave recommendations",
});
export const NOTE_MAX = 500;

export const STATUS_LABEL = Object.freeze({
  done: "Done by the system",
  admin_check: "Waiting for the Admin's check",
  with_hr: "With HR",
  open: "Open",
  couldnt_decide: "Couldn't decide",
  undone: "Undone by HR",
  closed: "Closed",
});

/** Still needs someone. */
export const isWaiting = (status) => ["admin_check", "with_hr", "open", "couldnt_decide"].includes(status);

/**
 * The counts on the Automation card. "For you": the Admin checks what the
 * system prepared; HR decides what was forwarded, the open flags and what the
 * system could not decide.
 */
export function summarizeAutomation(actions, role) {
  const list = actions || [];
  const since = Date.now() - 864e5;
  const count = (fn) => list.filter(fn).length;
  return {
    done_today: count((a) => a.status === "done" && Date.parse(a.created_at) >= since),
    admin_check: count((a) => a.status === "admin_check"),
    with_hr: count((a) => a.status === "with_hr"),
    open: count((a) => a.status === "open"),
    couldnt_decide: count((a) => a.status === "couldnt_decide"),
    escalated: count((a) => isWaiting(a.status) && a.escalated_at),
    for_you: role === "admin"
      ? count((a) => a.status === "admin_check")
      : count((a) => ["with_hr", "open", "couldnt_decide"].includes(a.status)),
  };
}
