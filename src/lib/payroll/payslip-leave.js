/**
 * The Leave Balance box of a payslip (2026-11-25): the employee's leave
 * credits at the payslip's date (the last day of its pay period), for
 * information only. Never part of the pay, never stored on the payslip.
 *
 *   Credits for the year   the same entitlement My Leave shows (leaveBalances:
 *                          the shared pool, or the per-type credits before it)
 *   Used to date           approved paid leave of that year with days up to the
 *                          payslip date (this period included), counted as My
 *                          Leave counts them (requestDays: calendar days, ½ day)
 *   Remaining              credits − used, never below 0 (pool rule 2026-11-24)
 *
 * One lookup per year for all of an employee's payslips. Null when the credits
 * cannot be read (the box is then not shown; nothing is guessed).
 */

import { leaveBalances } from "@/lib/employees/classification-server";
import { CREDIT_LEAVE_TYPES, SIL_LEAVE_TYPES } from "@/lib/employees/classification";
import { requestDays } from "@/lib/leave-requests/split";
import { periodFromLabel } from "@/lib/payroll/periods";
import { fetchAllIn } from "@/lib/supabase/fetch-all";

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const paidRequest = (r) => String(r.pay_status || "with_pay").toLowerCase() !== "without_pay";

/** The balance on `dateKey` from the year's entitlement and approved requests (pure; exported for tests). */
export function balanceOnDate(entitlement, requests, dateKey) {
  const upTo = (requests || [])
    .filter((r) => String(r.start_date || "") <= dateKey)
    .map((r) => ({ ...r, end_date: String(r.end_date || r.start_date) > dateKey ? dateKey : (r.end_date || r.start_date) }));
  const usedByType = Object.fromEntries(CREDIT_LEAVE_TYPES.map((t) => [t, round1(upTo.filter((r) => r.leave_type === t && paidRequest(r)).reduce((s, r) => s + requestDays(r), 0))]));
  const pooled = Boolean(entitlement?.pool);
  const allotment = pooled
    ? Number(entitlement.pool.allotment) || 0
    : SIL_LEAVE_TYPES.reduce((s, t) => s + (Number(entitlement?.by_type?.[t]?.allotment) || 0), 0);
  const used = round1(CREDIT_LEAVE_TYPES.reduce((s, t) => s + usedByType[t], 0));
  return {
    label: pooled ? "Vacation, sick, emergency (one pool)" : "Vacation, sick and emergency",
    year: Number(String(dateKey).slice(0, 4)),
    as_of: dateKey,
    allotment: round1(allotment),
    used,
    used_by_type: usedByType,
    remaining: round1(Math.max(0, allotment - used)),
    without_pay_used: round1(upTo.filter((r) => !paidRequest(r)).reduce((s, r) => s + requestDays(r), 0)),
  };
}

/** The payslip's date: the last day of its pay period ("November 1-15, 2026" -> "2026-11-15"), or null. */
export function payslipDateKey(payPeriod) {
  return periodFromLabel(payPeriod)?.end_key || null;
}

/**
 * Map dateKey -> balance for one employee. Every failure gives an empty map
 * (the payslip then shows no box).
 */
export async function leaveBalancesAtDates(supabase, employeeId, dateKeys) {
  const out = new Map();
  const keys = [...new Set((dateKeys || []).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(String(k || ""))))];
  if (!employeeId || !keys.length) return out;
  const years = [...new Set(keys.map((k) => Number(k.slice(0, 4))))];
  for (const year of years) {
    try {
      const [entitlements, requests] = await Promise.all([
        // The entitlement only (no requests: used is counted per date below).
        leaveBalances(supabase, [employeeId], year, { requests: [] }),
        fetchAllIn(() => supabase.from("leave_requests").select("id,employee_id,leave_type,start_date,end_date,status,pay_status,half_day")
          .eq("status", "approved").gte("start_date", `${year}-01-01`).lte("start_date", `${year}-12-31`).order("id", { ascending: true }), "employee_id", [employeeId]),
      ]);
      if (requests.error) continue;
      const entitlement = entitlements?.[employeeId];
      if (!entitlement) continue;
      keys.filter((k) => Number(k.slice(0, 4)) === year).forEach((k) => out.set(k, balanceOnDate(entitlement, requests.data || [], k)));
    } catch {
      // No box for that year's payslips.
    }
  }
  return out;
}

/** Sets `leave_balance` on each payslip object (with its pay_period) of one employee. Returns the list. */
export async function attachLeaveBalances(supabase, employeeId, payslips) {
  const list = (payslips || []).filter(Boolean);
  // Final pay and 13th month payslips have no pay period date: no box.
  const dates = list.map((p) => (p.final_pay ? null : payslipDateKey(p.pay_period || p.period_label)));
  const balances = await leaveBalancesAtDates(supabase, employeeId, dates.filter(Boolean));
  list.forEach((p, i) => { p.leave_balance = (dates[i] && balances.get(dates[i])) || null; });
  return payslips;
}

/** One payslip's details (buildPayslipDetails) with its `leave_balance`; returns the details. */
export async function withLeaveBalance(supabase, details, employeeId) {
  if (!details) return details;
  await attachLeaveBalances(supabase, employeeId, [details]);
  return details;
}
