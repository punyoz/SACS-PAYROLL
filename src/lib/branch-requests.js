/**
 * Branch oversight requests (public.branch_admin_requests, 20261020020000):
 * what a branch Admin sends HR, and what HR (or, for RFID issues, the Super
 * Admin) decides. The Admin recommends, HR decides.
 *
 *   attendance_flag        Pending → Resolved
 *   leave_endorsement      Endorsed / Not endorsed (HR decides the leave itself)
 *   incident_report        Pending → Resolved (a no-show also opens an AWOL case)
 *   schedule_request       Pending → Approved / Rejected
 *   transfer_endorsement   Endorsed / Not endorsed (HR decides the transfer itself)
 *   rfid_issue             Pending → Resolved (HR or Super Admin)
 *   overtime_confirmation  Endorsed / Not endorsed (the Accountant reads it)
 *   incentive_endorsement  Pending → Approved (an incentive item is filed) / Rejected
 *
 * Shared by the server routes and the screens (no server-only imports here).
 */

export const REQUEST_KINDS = Object.freeze({
  attendance_flag: { label: "Attendance flag", decisions: ["resolve"] },
  leave_endorsement: { label: "Leave recommendation", decisions: [], endorsement: true },
  incident_report: { label: "Incident / AWOL report", decisions: ["resolve"] },
  schedule_request: { label: "Work schedule request", decisions: ["approve", "reject"] },
  transfer_endorsement: { label: "Transfer endorsement", decisions: [], endorsement: true },
  rfid_issue: { label: "RFID issue", decisions: ["resolve"] },
  overtime_confirmation: { label: "Overtime / substitute confirmation", decisions: [], endorsement: true },
  incentive_endorsement: { label: "Incentive recommendation", decisions: ["approve", "reject"] },
});

/** The six status labels, the same on every screen. */
export const STATUS_LABELS = Object.freeze({
  pending: "Pending",
  endorsed: "Endorsed",
  not_endorsed: "Not endorsed",
  approved: "Approved",
  rejected: "Rejected",
  resolved: "Resolved",
});

export const STATUS_TONES = Object.freeze({
  pending: "gold",
  endorsed: "success",
  not_endorsed: "danger",
  approved: "success",
  rejected: "danger",
  resolved: "info",
});

export const DECISION_STATUS = Object.freeze({ approve: "approved", reject: "rejected", resolve: "resolved" });

export const INCIDENT_TYPES = Object.freeze({
  no_show: "No-show / possible AWOL",
  tardiness: "Repeated tardiness",
  misconduct: "Misconduct",
  other: "Other",
});

export const RFID_ISSUE_TYPES = Object.freeze({
  lost_card: "Lost card",
  broken_card: "Broken card",
  reader_fault: "Reader not working",
  other: "Other",
});

export const SCHEDULE_REQUEST_TYPES = Object.freeze({
  schedule: "Work schedule change",
  class_load: "Class-load change",
});

export const OVERTIME_TYPES = Object.freeze({
  overtime: "Overtime",
  substitute: "Substitute teaching",
});

export const ANNOUNCEMENT_CATEGORIES = Object.freeze({
  general: "General",
  holiday: "Holiday",
  meeting: "Meeting",
  schedule_change: "Schedule change",
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "—");
}

/** One history entry: who, their role, when, the status and the remark. */
export function historyEntry({ action, status, by, byName, role, note = null, at = new Date().toISOString() }) {
  return { action, status, by: by || null, by_name: byName || null, role: role || null, note: note || null, at };
}

/** The request as the screens show it. */
export function shapeRequest(row, { employeeName } = {}) {
  if (!row) return null;
  return {
    ...row,
    kind_label: REQUEST_KINDS[row.kind]?.label || row.kind,
    status_label: statusLabel(row.status),
    employee_name: employeeName || row.details?.employee_name || null,
    history: Array.isArray(row.history) ? row.history : [],
  };
}

/** One line describing what a request is about, for HR's tables. */
export function requestSummary(r) {
  const d = r?.details || {};
  switch (r?.kind) {
    case "attendance_flag": return `Attendance ${d.log_date || ""} · ${d.log_status || ""}`;
    case "leave_endorsement": return `${d.leave_type || "Leave"} · ${d.start_date || ""}${d.end_date && d.end_date !== d.start_date ? ` to ${d.end_date}` : ""}`;
    case "incident_report": return `${d.incident_type_label || "Incident"} · ${d.incident_date || ""}`;
    case "schedule_request": return `${d.request_type_label || "Schedule"} from ${d.effective_from || ""}: ${d.requested || ""}`;
    case "transfer_endorsement": return `Transfer (${d.direction || ""})`;
    case "rfid_issue": return `${d.issue_type_label || "RFID issue"}${d.device ? ` · ${d.device}` : ""}`;
    case "overtime_confirmation": return `${d.work_type_label || "Overtime"} · ${d.hours || 0} h on ${d.work_date || ""}${d.covered_for ? ` (for ${d.covered_for})` : ""}`;
    case "incentive_endorsement": return `${d.kind === "overload" ? `Overload ${d.hours} h` : `Incentive ₱${Number(d.amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`} · ${d.description || ""} (${d.item_date || ""})`;
    default: return "";
  }
}
