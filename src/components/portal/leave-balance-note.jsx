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
  const pending = request && ["pending_admin", "pending_accountant"].includes(request.status);
  const split = pending && request.pay_status !== "without_pay" ? splitForBalance(request, balance.with_pay_remaining) : null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)} data-testid="leave-balance">
      Leave with pay: {balance.with_pay_used} of {balance.with_pay_allotment} days used, {balance.with_pay_remaining} remaining
      {split?.without_pay_days ? <span className="block font-medium text-warning">Over the balance: {describeSplit(split)} on approval.</span> : null}
    </p>
  );
}
