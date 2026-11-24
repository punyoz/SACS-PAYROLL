// One branch's numbers, the same on the branch Admin's dashboard and on HR's
// (2026-11-24): what waits for HR, what HR approved / rejected this month,
// the open attendance flags and today's absences. Both dashboards call this
// one function, so the two sides can never disagree.

const MONTH_START = (today) => `${today.slice(0, 7)}-01`;
const manilaStart = (key) => new Date(`${key}T00:00:00+08:00`).toISOString();

async function count(query) {
  const { count: n, error } = await query;
  if (error) return 0;
  return Number(n) || 0;
}

/**
 * { waiting, approved, rejected, flags, absent_today } for one branch.
 * waiting: leave, overtime, corrections, substitutions, transfers out and the
 * Admin's filings still waiting for HR; approved / rejected: decided since the
 * 1st of this month (Manila); flags: the system's attendance flags still open
 * or with HR; absent_today: today's Absent records.
 */
export async function branchCounts(supabase, branchId, today) {
  const since = manilaStart(MONTH_START(today));
  const head = { count: "exact", head: true };
  const decided = (table, col, status) => supabase.from(table).select("id", head).eq("branch_id", branchId).eq("status", status).gte(col, since);
  const [lp, op, cp, sp, tp, bp, la, oa, ca, sa, ta, ba, lr, or, cr, sr, tr, br, flags, absent] = await Promise.all([
    count(supabase.from("leave_requests").select("id", head).eq("branch_id", branchId).in("status", ["pending_admin", "pending_accountant"])),
    count(supabase.from("overtime_requests").select("id", head).eq("branch_id", branchId).eq("status", "pending")),
    count(supabase.from("attendance_corrections").select("id", head).eq("branch_id", branchId).eq("status", "pending")),
    count(supabase.from("substitutions").select("id", head).eq("branch_id", branchId).eq("status", "pending")),
    count(supabase.from("transfer_requests").select("id", head).eq("from_branch_id", branchId).eq("status", "pending")),
    count(supabase.from("branch_admin_requests").select("id", head).eq("branch_id", branchId).eq("status", "pending")),
    count(decided("leave_requests", "decided_at", "approved")),
    count(decided("overtime_requests", "decided_at", "approved")),
    count(decided("attendance_corrections", "approved_at", "approved")),
    count(decided("substitutions", "decided_at", "approved")),
    count(supabase.from("transfer_requests").select("id", head).eq("from_branch_id", branchId).eq("status", "approved").gte("reviewed_at", since)),
    count(supabase.from("branch_admin_requests").select("id", head).eq("branch_id", branchId).in("status", ["approved", "resolved"]).gte("decided_at", since)),
    count(decided("leave_requests", "decided_at", "rejected")),
    count(decided("overtime_requests", "decided_at", "rejected")),
    count(decided("attendance_corrections", "approved_at", "rejected")),
    count(decided("substitutions", "decided_at", "rejected")),
    count(supabase.from("transfer_requests").select("id", head).eq("from_branch_id", branchId).eq("status", "rejected").gte("reviewed_at", since)),
    count(supabase.from("branch_admin_requests").select("id", head).eq("branch_id", branchId).eq("status", "rejected").gte("decided_at", since)),
    count(supabase.from("automation_actions").select("id", head).eq("branch_id", branchId).eq("module", "attendance_flags").in("status", ["open", "with_hr", "admin_check"])),
    count(supabase.from("attendance_logs").select("id", head).eq("branch_id", branchId).eq("log_date", today).eq("status", "Absent").eq("archived_duplicate", false)),
  ]);
  return {
    waiting: lp + op + cp + sp + tp + bp,
    approved: la + oa + ca + sa + ta + ba,
    rejected: lr + or + cr + sr + tr + br,
    flags,
    absent_today: absent,
  };
}

export const BRANCH_COUNT_LABELS = Object.freeze({
  waiting: "Waiting for HR",
  approved: "Approved this month",
  rejected: "Rejected this month",
  flags: "Open attendance flags",
  absent_today: "Absent today",
});
