// What "these accounts, Oct 1 to today" means, table by table (2026-11-24). The SAME list is used to wipe the
// local copy before the build, to collect the built rows, and to delete + reload on live (scripts/demo/period.mjs).
// Children come before parents. `S` = the accounts' ids, `P` = S + anyone else paid inside the replaced runs, `B` = their branches, `F` = the first day.
// Nothing else is in scope: other people, other branches, days before F, configuration, audit logs.

const LABELS = "('October 1-15, 2026','October 16-31, 2026','November 1-15, 2026','November 16-30, 2026')";

/** [table, where] in delete order. S / B / F are replaced by lists / the date. */
export const SCOPE = [
  ["payroll_loan_payments", "loan_id in (select id from payroll_loans where employee_id in S) or (employee_id in P and period_start >= F)"],
  ["payroll_cash_advances", "employee_id in S and date_granted >= F"],
  ["payroll_loans", "employee_id in S and date_granted >= F"],
  ["tenure_protection_applications", "employee_id in P and pay_period in " + LABELS],
  ["payroll_deductions", "employee_id in P and period_start >= F"],
  ["payroll_incentives", "employee_id in P and period_start >= F"],
  ["payroll_monthly_incentives", "employee_id in S and item_date >= F"],
  ["payroll_review_flags", "employee_id in P and pay_period in " + LABELS],
  ["payroll_corrections", "employee_id in P and period_label in " + LABELS],
  ["payroll_final_overrides", "employee_id in P and pay_period in " + LABELS],
  ["payroll_final_pay_submissions", "employee_id in S and separated_on >= F"],
  ["payroll_thirteenth_month", "employee_id in S and year = 2026"],
  ["payroll_subsidy_requests", "employee_id in S and created_at >= F"],
  ["payroll_subsidy_adjustments", "employee_id in S and applied_period_start >= F"],
  ["notifications", "run_id in (select id from payroll_runs where branch_id in B and period_start >= F)"],
  ["payroll_approval_history", "run_id in (select id from payroll_runs where branch_id in B and period_start >= F)"],
  ["payroll_run_exclusions", "run_id in (select id from payroll_runs where branch_id in B and period_start >= F)"],
  ["payroll_run_items", "run_id in (select id from payroll_runs where branch_id in B and period_start >= F) or (employee_id in P and entry_id in (select id from payroll_entries where pay_period in " + LABELS + "))"],
  ["payroll_entries", "(employee_id in P and pay_period in " + LABELS + ") or (employee_id in S and pay_period like 'Final pay%' and created_at >= F)"],
  ["payroll_records", "employee_id in P and period_start >= F"],
  ["payroll_runs", "branch_id in B and period_start >= F"],
  ["early_bird_winners", "period_start >= F"],
  ["incentive_recommendations", "employee_id in S and period_start >= F"],
  ["substitutions", "(absent_employee_id in S or substitute_id in S) and sub_date >= F"],
  ["attendance_overtime_approvals", "employee_id in S and log_date >= F"],
  ["overtime_requests", "employee_id in S and request_date >= F"],
  ["attendance_corrections", "employee_id in S and log_date >= F"],
  ["holiday_work_reviews", "employee_id in S and holiday_date >= F"],
  ["attendance_logs_history", "log_id in (select id from attendance_logs where employee_id in S and log_date >= F)"],
  ["attendance_taps", "employee_id in S and log_date >= F"],
  ["attendance_blocked_taps", "employee_id in S and log_date >= F"],
  ["attendance_logs", "employee_id in S and log_date >= F"],
  ["leave_requests", "employee_id in S and end_date::date >= F"],
  ["awol_replies", "employee_id in S"],
  ["awol_notices", "employee_id in S"],
  ["employee_status_changes", "employee_id in S and effective_on >= F"],
  ["employee_awol_cases", "employee_id in S"],
  ["tenure_protection_grants", "employee_id in S"],
  ["employee_hr_reminders", "employee_id in S and due_on >= F"],
  ["automation_actions", "employee_id in S and created_at >= F"],
  // Theirs, and the ones others got about their requests / payslips (no link column: every kind but announcements).
  ["notifications", "created_at >= F and (recipient_id in S or kind <> 'branch_announcement')"],
  ["special_working_days", "work_date >= F"],
];

const list = (ids) => (ids.length ? `(${ids.map((i) => `'${String(i).replace(/'/g, "''")}'::uuid`).join(", ")})` : "(null::uuid)");

/** The where clause with the lists filled in. */
export function scopeWhere(where, { ids, branches, from, paid = [] }) {
  return where.replace(/\bin P\b/g, `in ${list([...new Set([...ids, ...paid])])}`).replace(/\bin S\b/g, `in ${list(ids)}`).replace(/\bin B\b/g, `in ${list(branches)}`).replace(/\bF\b/g, `'${from}'::date`);
}

/** DELETE statements, children first (triggers off for the history tables kept append-only). */
export function wipeSql(scope) {
  const tables = SCOPE.map(([t]) => t);
  return ["begin;", ...tables.map((t) => `alter table public.${t} disable trigger user;`),
    ...SCOPE.map(([t, w]) => `delete from public.${t} where ${scopeWhere(w, scope)};`),
    ...tables.map((t) => `alter table public.${t} enable trigger user;`), "commit;"].join("\n");
}
