/**
 * Archived branches (2026-11-24): a branch is archived, never deleted. Archived
 * branches drop out of branch dropdowns, dashboards and payroll processing; a
 * "Show archived" filter brings them back for history. ("Closed" is the older
 * word for the same thing and is treated alike.)
 */
export const BRANCH_ARCHIVED = "Archived";

export function isArchivedBranch(branch) {
  const s = String(branch?.status || "").trim().toLowerCase();
  return s === "archived" || s === "closed";
}

/** The branches a dropdown offers: the active ones, plus archived ones when asked (or the one already chosen). */
export function branchOptions(list, { showArchived = false, selected = null } = {}) {
  return (list || []).filter((b) => showArchived || !isArchivedBranch(b) || (selected && String(b.id) === String(selected)));
}
