/**
 * The Loans table and its Excel / PDF export use these same rules (alpha test
 * B4; 2026-11-19 search, sort and wording too), so the export lists exactly
 * the rows the screen shows, in the same order, in the same words.
 */

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

/** The status as the table's badge says it. */
export function loanStatusLabel(loan) {
  if (loan.approval_status === "pending") return "Pending HR approval";
  if (loan.approval_status === "rejected") return "Rejected by HR";
  if (loan.awaiting_decision) return "Awaiting decision";
  if (loan.status === "paid") return "Paid";
  if (loan.status === "suspended") return "Suspended";
  return "Active";
}

/** Only an approved, active loan can be suspended; only a suspended one resumed (the server enforces it). */
export function loanCanSuspend(loan) {
  return loan.loan_type !== "subsidy_advance" && loan.approval_status !== "pending" && loan.approval_status !== "rejected" && loan.status === "active";
}
export function loanCanResume(loan) {
  return loan.loan_type !== "subsidy_advance" && loan.approval_status !== "pending" && loan.approval_status !== "rejected" && loan.status === "suspended";
}

const dateText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }).format(d);
};
/** A note HR only wrote to say "approved" adds nothing to "Approved by …". */
const echo = (note) => /^\s*approved\.?\s*$/i.test(String(note || ""));

/**
 * HR's decision in one line: "Approved by Demo HR One · Nov 15, 2026" (with
 * HR's note only when it says something), "Rejected by Demo HR One: Not within
 * this year's limit." Empty while pending, and for a subsidy advance.
 */
export function loanDecisionText(loan) {
  if (!loan.decided_by_name || loan.approval_status === "pending" || loan.loan_type === "subsidy_advance") return "";
  if (loan.approval_status === "rejected") return `Rejected by ${loan.decided_by_name}${loan.decision_note ? `: ${loan.decision_note}` : ""}`;
  const when = loan.decided_at ? ` · ${dateText(loan.decided_at)}` : "";
  return `Approved by ${loan.decided_by_name}${when}${loan.decision_note && !echo(loan.decision_note) ? `: ${loan.decision_note}` : ""}`;
}

/** What the search box matches: the employee, their ID, the description and the type. */
export function loanSearchText(loan) {
  return `${loan.employee_name || ""} ${loan.employee_code || ""} ${loan.description || ""} ${loan.type_label || ""}`;
}
export function loanMatchesQuery(loan, query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || loanSearchText(loan).toLowerCase().includes(q);
}

/** The sortable columns: their value and their name in an export's filter line. */
export const LOAN_SORTS = {
  employee_name: { label: "Employee", value: (l) => l.employee_name, words: ["A–Z", "Z–A"] },
  date_granted: { label: "Given", value: (l) => l.date_granted, words: ["oldest first", "newest first"] },
  total: { label: "Total payable", value: (l) => Number(l.total_payable || 0), words: ["lowest first", "highest first"] },
  balance: { label: "Balance", value: (l) => Number(l.remaining_balance || 0), words: ["lowest first", "highest first"] },
};

/** "date_granted:desc" → { key, dir }; anything else → null (the list's own order: newest given first). */
export function parseLoanSort(text) {
  const [key, dir] = String(text || "").split(":");
  return LOAN_SORTS[key] && ["asc", "desc"].includes(dir) ? { key, dir } : null;
}

export function loanSortLabel(sort) {
  if (!sort || !LOAN_SORTS[sort.key]) return "Given (newest first)";
  const s = LOAN_SORTS[sort.key];
  return `${s.label} (${s.words[sort.dir === "desc" ? 1 : 0]})`;
}

const compare = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
};

/** The same order the table shows (DataTable sorts the same way); no sort keeps the list's own order. */
export function sortLoans(loans, sort) {
  if (!sort || !LOAN_SORTS[sort.key]) return loans;
  const value = LOAN_SORTS[sort.key].value;
  const factor = sort.dir === "desc" ? -1 : 1;
  return [...loans].sort((a, b) => factor * compare(value(a), value(b)));
}
