"use client";

import { describeSplit, splitForBalance } from "@/lib/leave-requests/split";
import { cn } from "@/lib/utils";

/**
 * Read-only paid-leave balance (2026-11-12): "2 of 6 days used, 4 remaining",
 * and, for a pending WITH-pay request over it, how approval will split it
 * ("4 days with pay, 1 day without pay"). The server re-checks at approval.
 */
export function LeaveBalanceNote({ balance, request = null, className }) {
  if (!balance) return null;
  // Statutory leave (maternity, paternity, …) uses no yearly credits.
  if (request && balance.by_type && !balance.by_type[request.leave_type]) {
    return <p className={cn("text-xs text-muted-foreground", className)} data-testid="leave-balance">{request.leave_type}: statutory leave, filed per event (no yearly credits used).</p>;
  }
  // The credits of the request's own leave type (leave_credit_rules, 20261121010000); one shared pool since 2026-11-24.
  const own = request ? balance.by_type?.[request.leave_type] : null;
  const pooled = Boolean(balance.pool);
  const label = pooled ? "Leave credits" : own ? request.leave_type : "Leave with pay";
  const used = pooled ? balance.pool.used : own ? own.used : balance.with_pay_used;
  const allotment = own ? own.allotment : balance.with_pay_allotment;
  const remaining = own ? own.remaining : balance.with_pay_remaining;
  const pending = request && ["pending_admin", "pending_accountant"].includes(request.status);
  const split = pending && request.pay_status !== "without_pay" ? splitForBalance(request, remaining) : null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)} data-testid="leave-balance">
      {label}: {used} of {allotment} days used, {remaining} remaining
      {split?.without_pay_days ? <span className="block font-medium text-warning">Over the leave credits: {describeSplit(split)} on approval.</span> : null}
    </p>
  );
}
