/**
 * HR Reports (attendance, employee records): the screen's table and its
 * Excel / PDF / CSV share this order and this search text (2026-11-19).
 */

/** Branch name A–Z with Unassigned last, then the employee. */
export function sortByBranch(records, nameKey) {
  const branchKey = (r) => (r.branch_id ? r.branch_name || "Unknown branch" : "￿");
  return [...records].sort((a, b) => branchKey(a).localeCompare(branchKey(b)) || String(a[nameKey] || "").localeCompare(String(b[nameKey] || "")));
}

/** What the search box matches (one text, as the table does). */
export const hrReportSearchFields = (r) => [[r.employee_name, r.full_name, r.employee_id, r.branch_name, r.employee_type, r.position, r.email].join(" ")];
