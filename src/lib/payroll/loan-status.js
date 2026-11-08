/** The status filter (alpha test B4): the screen and the export use the same rule. */
export const LOAN_STATUS_LABELS = { all: "All", open: "Open", pending: "Pending HR approval", active: "Active", suspended: "Suspended", paid: "Paid", rejected: "Rejected by HR", subsidy: "Subsidy advances" };
export function loanMatchesStatus(loan, status) {
  switch (status) {
    case "pending": return loan.approval_status === "pending";
    case "rejected": return loan.approval_status === "rejected";
    case "active": return loan.status === "active" && !["pending", "rejected"].includes(loan.approval_status);
    case "suspended": return loan.status === "suspended";
    case "paid": return loan.status === "paid";
    case "subsidy": return loan.loan_type === "subsidy_advance";
    case "open": return loan.status !== "paid" && loan.approval_status !== "rejected";
    default: return true;
  }
}
export function loanStatusLabel(loan) {
  if (loan.approval_status === "pending") return "Pending HR approval";
  if (loan.approval_status === "rejected") return "Rejected by HR";
  if (loan.status === "paid") return "Paid";
  if (loan.status === "suspended") return "Suspended";
  return "Active";
}
