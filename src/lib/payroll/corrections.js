/**
 * Payroll corrections after HR approval (20261022020000_payroll_corrections.sql,
 * scenarios AC-06 / AC-08). An approved payslip is never changed: the
 * Accountant files a correction, HR approves it, and it is paid (an
 * underpayment, as an incentive item) or recovered (an overpayment, as a
 * deduction on the next 2nd-half payslips) on a later payslip.
 */

export const CORRECTION_KIND_LABELS = Object.freeze({
  underpayment: "Underpayment (pay the difference)",
  overpayment: "Overpayment (recover it)",
});

export const CORRECTION_STATUS_LABELS = Object.freeze({
  pending: "Pending HR Approval",
  approved: "Approved",
  rejected: "Rejected by HR",
  cancelled: "Cancelled",
});

export const CORRECTION_STATUS_TONES = Object.freeze({ pending: "warning", approved: "success", rejected: "danger", cancelled: "muted" });

const STATUS_BY_CODE = { forbidden: 403, not_found: 404, invalid_transition: 409, duplicate: 409, reason_required: 400, invalid: 400 };

/** A database refusal ("code: message") as { status, error, code }. */
export function describeCorrectionError(error) {
  const message = String(error?.message || "").replace(/^ERROR:\s*/, "");
  const match = message.match(/^([a-z_]+):\s*(.*)$/s);
  if (match && STATUS_BY_CODE[match[1]]) {
    const text = match[2].charAt(0).toUpperCase() + match[2].slice(1);
    return { status: STATUS_BY_CODE[match[1]], error: text, code: match[1] };
  }
  if (/does not exist|schema cache|could not find the function/i.test(message)) {
    return { status: 503, error: "Payroll corrections are not set up yet: apply 20261022020000_payroll_corrections.sql.", code: "not_ready" };
  }
  return { status: 500, error: "Not saved. Please try again.", code: "error" };
}

/** A row as the pages show it. */
export function shapeCorrection(row, { employeeName = null, branchName = null } = {}) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: employeeName || "—",
    branch_id: row.branch_id || null,
    branch_name: branchName || "—",
    entry_id: row.entry_id,
    period_label: row.period_label,
    payslip_no: row.payslip_no || null,
    kind: row.kind,
    kind_label: CORRECTION_KIND_LABELS[row.kind] || row.kind,
    amount: Number(row.amount) || 0,
    payrolls: Number(row.payrolls) || 1,
    reason: row.reason,
    status: row.status,
    status_label: CORRECTION_STATUS_LABELS[row.status] || row.status,
    requested_by_name: row.requested_by_name || null,
    requested_at: row.requested_at,
    decided_by_name: row.decided_by_name || null,
    decided_at: row.decided_at || null,
    decision_note: row.decision_note || null,
    applied: Boolean(row.applied_incentive_id || row.applied_loan_id),
    history: Array.isArray(row.history) ? row.history : [],
  };
}
