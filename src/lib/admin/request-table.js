/**
 * The Admin's branch requests table (e.g. Incentive recommendations) and its
 * Excel / PDF export share these search fields and sortable columns (2026-11-19).
 */

export const requestEmployee = (r) => r.employee_name || r.details?.employee_name || "";

export const requestSearchFields = (r) => [requestEmployee(r), r.admin_note, r.status_label];

export const REQUEST_SORTS = {
  employee_name: { label: "Employee", value: requestEmployee },
  filed: { label: "Sent", value: (r) => r.created_at },
  status: { label: "Status", value: (r) => r.status_label },
};
