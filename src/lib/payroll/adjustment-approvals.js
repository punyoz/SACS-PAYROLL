/**
 * HR approval of incentives, overload and loans (incl. cash advances)
 * before payroll uses them (20261027020000, decision 2026-10-27):
 *
 *   Accountant files ─► pending ─► HR approves ─► approved (payroll uses it)
 *                               └► HR rejects  ─► rejected (kept; never paid)
 *
 * A row without approval_status (before the migration, or written by the
 * database after an HR approval) counts as approved.
 */

export const APPROVAL_LABELS = Object.freeze({
  pending: { label: "Pending HR approval", tone: "gold" },
  approved: { label: "Approved by HR", tone: "success" },
  rejected: { label: "Rejected by HR", tone: "danger" },
});

export function approvalStatusOf(row) {
  const status = String(row?.approval_status || "approved");
  return APPROVAL_LABELS[status] ? status : "approved";
}

/** Payroll uses only approved incentives, overload and loans. */
export function isApproved(row) {
  return approvalStatusOf(row) === "approved";
}

/**
 * The day an item counts as filed for the payroll month: its approval, when
 * HR approved it (an item approved after the lock date is paid next month,
 * never lost in a month already processed), else when it was filed.
 */
export function filedAtOf(item) {
  return item?.decided_at && isApproved(item) ? item.decided_at : item?.created_at;
}

/** The approval fields a list row shows. */
export function approvalFields(row) {
  const status = approvalStatusOf(row);
  return {
    approval_status: status,
    approval_label: APPROVAL_LABELS[status].label,
    approval_tone: APPROVAL_LABELS[status].tone,
    decided_by_name: row?.decided_by_name || null,
    decided_at: row?.decided_at || null,
    decision_note: row?.decision_note || null,
  };
}

/** A database refusal as an HTTP answer. */
export function describeDecisionError(error) {
  const message = String(error?.message || error || "");
  if (/forbidden/i.test(message)) return { status: 403, code: "forbidden", error: "Only HR approves or rejects incentives, overload and loans." };
  if (/already_decided/i.test(message)) return { status: 409, code: "already_decided", error: message.replace(/^.*already_decided:\s*/i, "It ") };
  if (/not_found/i.test(message)) return { status: 404, code: "not_found", error: "Not found." };
  if (/invalid/i.test(message)) return { status: 400, code: "invalid", error: message.replace(/^.*invalid:\s*/i, "") };
  if (/does not exist|schema cache/i.test(message)) return { status: 503, code: "not_ready", error: "Approvals are not set up yet: apply 20261027020000_adjustment_approvals.sql." };
  return { status: 500, code: "error", error: "The decision was not saved." };
}
