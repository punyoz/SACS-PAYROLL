/**
 * Final pay HR approval (supabase/migrations/20261120010000_final_pay_hr_approval.sql):
 * shared by the Accountant's Final Pay route and HR's Final pay approvals.
 */

export const SUBMISSIONS = "payroll_final_pay_submissions";
export const LEGACY_LABEL = "Released before HR approval was required";
export const STATUS_LABELS = { pending: "Pending HR Approval", approved: "Paid/Released", rejected: "Rejected by HR" };
const DEADLINE_DAYS = 30;

/** Days left on the 30-day deadline (DOLE Labor Advisory 06-2020), counted to HR's approval. */
export function deadlineOf(separatedOn, today) {
  const d = new Date(`${separatedOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + DEADLINE_DAYS);
  const deadline = d.toISOString().slice(0, 10);
  return { deadline, days_left: Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) };
}

/** A submission as the lists show it. */
export function shapeSubmission(row) {
  if (!row) return null;
  const fp = row.item?.entry?.payroll?.final_pay || {};
  return {
    id: row.id, status: row.status, legacy: row.legacy, note: row.note,
    status_label: row.legacy ? LEGACY_LABEL : STATUS_LABELS[row.status] || row.status,
    release_on: row.release_on, net_pay: Number(row.net_pay) || 0, payslip_no: row.payslip_no, correction: Boolean(row.corrects_entry_id),
    submitted_by_name: row.submitted_by_name, submitted_at: row.submitted_at,
    decided_by_name: row.decided_by_name, decided_by_role: row.decided_by_role, decided_at: row.decided_at, reject_reason: row.reject_reason,
    overpayment_to_recover: Number(fp.overpayment_to_recover) || 0,
  };
}

/** The final pay approval error a database refusal maps to: { status, error }. */
export function describeDecideError(error) {
  const text = String(error?.message || error || "");
  const [code] = text.split(":");
  const status = { forbidden: 403, not_found: 404, invalid_transition: 409, reason_required: 400, invalid: 400 }[code] || 500;
  return { status, error: status === 500 ? "The final pay could not be decided. Try again." : text.slice(code.length + 1).trim() || text };
}

/** After HR's (or the stand-in's) decision: the bells, generic, no amounts (decided 2026-11-09). Never throws. */
export async function notifyFinalPayDecision(supabase, notify, row, action, reason) {
  try {
    if (action === "approve") {
      await notify(supabase, [row.employee_id], {
        kind: "final_pay_released", title: "Your final pay is released",
        body: `Your final pay was approved by HR. Release date: ${row.release_on}. Open My Payslips to view it.`, link_page: "emp-payslips",
      });
      await notify(supabase, [row.submitted_by], {
        kind: "final_pay_approved", title: "Final pay approved",
        body: `HR approved the final pay for ${row.employee_name}. It is now released to the employee.`, link_page: "ac-final-pay",
      });
    } else {
      await notify(supabase, [row.submitted_by], {
        kind: "final_pay_rejected", title: "Final pay rejected by HR",
        body: `HR rejected the final pay for ${row.employee_name}: ${reason}. Recompute and submit it again.`, link_page: "ac-final-pay",
      });
    }
  } catch { /* decided either way */ }
}
