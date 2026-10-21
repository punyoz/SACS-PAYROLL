/**
 * Subsidy processing (20261021010000_subsidy_processing.sql): the
 * Accountant processes a subsidy item, HR approves or rejects it, payroll
 * applies it. The database functions own every rule (who, which status
 * move, the amounts); this file shapes what the routes send and show.
 *
 *   pending ─► processed ─► approved ─► applied
 *                  │
 *                  └─► rejected ─► (Accountant fixes, resubmits) ─► processed
 */

import { roundPeso } from "@/lib/payroll/money";

export const SUBSIDY_STATUS_LABELS = Object.freeze({
  pending: "Pending",
  processed: "Processed",
  approved: "Approved",
  rejected: "Rejected",
  applied: "Applied to payroll",
});

export const SUBSIDY_STATUS_TONES = Object.freeze({
  pending: "gold",
  processed: "info",
  approved: "success",
  rejected: "danger",
  applied: "success",
});

export const SUBSIDY_KIND_LABELS = Object.freeze({
  adjustment: "Missed-month adjustment",
  advance: "Subsidy advance",
  excess_settlement: "Excess advance settlement",
});

export const EXCESS_OPTIONS = Object.freeze({
  convert: "Convert to a cash advance (teacher signed consent)",
  offset_next_subsidy: "Offset against next year's subsidy",
  waive: "Waive (write off)",
  final_pay: "Recover from final pay on separation",
  collect: "Refer for collection",
});

const STATUS_BY_CODE = { forbidden: 403, not_found: 404, invalid_transition: 409, remarks_required: 400, invalid: 400 };

/** A database refusal as { status, error } for the person: "forbidden: only HR…" → 403 "Only HR…". */
export function describeSubsidyError(error) {
  const message = String(error?.message || "").replace(/^ERROR:\s*/, "");
  const match = message.match(/^([a-z_]+):\s*(.*)$/s);
  if (match && STATUS_BY_CODE[match[1]]) {
    const text = match[2].charAt(0).toUpperCase() + match[2].slice(1);
    return { status: STATUS_BY_CODE[match[1]], error: text, code: match[1] };
  }
  const code = String(error?.code || "");
  if (code === "42501") return { status: 403, error: message || "Not allowed.", code: "forbidden" };
  if (["P0001", "23514", "23505"].includes(code)) return { status: 400, error: message || "Not saved.", code: "invalid" };
  if (/does not exist|schema cache|could not find the function/i.test(message)) {
    return { status: 503, error: "Subsidy processing is not set up yet: apply 20261021010000_subsidy_processing.sql.", code: "not_ready" };
  }
  return { status: 500, error: "Not saved. Please try again.", code: "error" };
}

/** What the item is, in one line ("May 2026 · 1 month", "Waive (write off)", ...). */
export function describeDetails(row) {
  const d = row?.details || {};
  if (row?.kind === "adjustment") return `${d.months_label || "—"} · ${d.months_missed || "?"} month${Number(d.months_missed) === 1 ? "" : "s"}`;
  if (row?.kind === "advance") return `Released ${d.date_granted || "—"}${d.description ? ` · ${d.description}` : ""}`;
  if (row?.kind === "excess_settlement") {
    if (!d.option) return "Not processed yet";
    const option = EXCESS_OPTIONS[d.option] || d.option;
    return d.option === "convert" ? `${option} · ${d.number_of_payrolls || 1} payroll${Number(d.number_of_payrolls) === 1 ? "" : "s"}` : option;
  }
  return "—";
}

/** A request row as the screens show it. */
export function shapeSubsidyRequest(row, { employeeName = null, year = null } = {}) {
  const history = Array.isArray(row.history) ? row.history : [];
  return {
    id: row.id,
    kind: row.kind,
    kind_label: SUBSIDY_KIND_LABELS[row.kind] || row.kind,
    employee_id: row.employee_id,
    employee_name: employeeName || "—",
    branch_id: row.branch_id || null,
    subsidy_balance_id: row.subsidy_balance_id,
    loan_id: row.loan_id || null,
    year,
    status: row.status,
    status_label: SUBSIDY_STATUS_LABELS[row.status] || row.status,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    reason: row.reason || null,
    details: row.details || {},
    details_label: describeDetails(row),
    submission_no: row.submission_no || 0,
    requested_by_name: row.requested_by ? row.requested_by_name : "System",
    requested_at: row.requested_at || null,
    processed_by_name: row.processed_by_name || null,
    processed_at: row.processed_at || null,
    decided_by_name: row.decided_by_name || null,
    decided_at: row.decided_at || null,
    decision_note: row.decision_note || null,
    applied_at: row.applied_at || null,
    applied_note: row.applied_note || null,
    // The last rejection, shown to the Accountant while fixing it.
    last_rejection: [...history].reverse().find((h) => h.action === "rejected") || null,
    history,
  };
}

/**
 * Every decision, newest first, from the requests' histories: who processed
 * it, who decided, when, and why. Never removed once made.
 */
export function decisionHistory(requests) {
  const out = [];
  requests.forEach((r) => {
    let processedBy = null;
    let processedAt = null;
    (r.history || []).forEach((event, index) => {
      if (event.action === "processed" || event.action === "resubmitted") { processedBy = event.actor_name; processedAt = event.at; }
      if (event.action !== "approved" && event.action !== "rejected") return;
      out.push({
        id: `${r.id}-${index}`,
        request_id: r.id,
        kind: r.kind,
        kind_label: r.kind_label,
        employee_name: r.employee_name,
        amount: r.amount,
        details_label: r.details_label,
        requested_by_name: r.requested_by_name,
        requested_at: r.requested_at,
        processed_by_name: processedBy,
        processed_at: processedAt,
        decision: event.action,
        decision_label: event.action === "rejected" ? "Rejected" : r.status === "applied" ? "Approved · Applied to payroll" : "Approved",
        decided_by_name: event.actor_name,
        decided_at: event.at,
        reason: event.note || (event.action === "approved" ? r.applied_note : null) || null,
      });
    });
  });
  return out.sort((a, b) => String(b.decided_at || "").localeCompare(String(a.decided_at || "")));
}

/**
 * What a subsidy balance can still advance on a date (the same rule as
 * payroll_loans_open, which refuses anything above it when HR approves).
 */
export function advanceAvailable(balance, onDate) {
  let cap = roundPeso(balance.remaining);
  if (balance.advance_limit === "earned_to_date") {
    const [y, m] = String(onDate).split("-").map(Number);
    const [ey, em] = String(balance.eligible_from).split("-").map(Number);
    const months = Math.max(0, (y * 12 + m) - (ey * 12 + em) + 1);
    cap = Math.min(cap, roundPeso(Number(balance.annual_amount) * Math.min(months, balance.eligible_months) / 12
      - Number(balance.advances_total) - Number(balance.paid_out)));
  }
  return Math.max(0, roundPeso(cap));
}
