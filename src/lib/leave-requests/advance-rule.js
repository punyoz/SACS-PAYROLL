/**
 * Leave must be filed at least LEAVE_ADVANCE_DAYS days ahead: the start date
 * may be no earlier than the submission date (Asia/Manila) plus 7 days.
 * Filed Oct 13, 2026 -> the earliest start is Oct 20, 2026.
 *
 * The employee's date picker disables earlier days; POST
 * /api/employee/leave-requests enforces the same rule on the server.
 */

import { manilaDateKey } from "@/lib/payroll/periods";

export const LEAVE_ADVANCE_DAYS = 7;

export const LEAVE_ADVANCE_MESSAGE = "Leave requests must be submitted at least 7 days before the leave start date.";

/** The earliest allowed start date for a request submitted on `submittedKey` ("YYYY-MM-DD"). */
export function earliestLeaveStart(submittedKey = manilaDateKey()) {
  const date = new Date(`${submittedKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + LEAVE_ADVANCE_DAYS);
  return date.toISOString().slice(0, 10);
}

/** True when a request submitted at `submittedAt` (a Date) may start on `startKey`. */
export function meetsAdvanceRule(startKey, submittedAt = new Date()) {
  return String(startKey || "") >= earliestLeaveStart(manilaDateKey(submittedAt));
}
