/**
 * Subsidy processing (20261021010000): the Accountant processes, HR approves,
 * payroll applies. The database rules are checked in
 * scripts/checks/subsidy-processing-scenarios.sql; here, what the screens and
 * the payslip show.
 */

import { describe, it, expect } from "vitest";
import { subsidyForPayslip } from "@/lib/payroll/teacher-subsidy";
import {
  SUBSIDY_STATUS_LABELS,
  advanceAvailable,
  decisionHistory,
  describeDetails,
  describeSubsidyError,
  shapeSubsidyRequest,
} from "@/lib/payroll/subsidy-requests";

const SECOND_HALF = { start_key: "2026-10-16", end_key: "2026-10-31", label: "October 16-31, 2026" };

describe("an approved adjustment on the payslip", () => {
  it("is an earning on the next 16–end payslip, named with HR's approver, and marked to be applied", () => {
    const ctx = {
      balance: null, advances: [], prior_offsets: [], memo_advances: [],
      adjustments: [{ id: "adj-1", months_missed: 1, months_label: "Oct 2026", amount: 2000, decided_by_name: "Hana HR", tax_treatment: "exempt" }],
      benefits_ytd: 0, excess_taxed_ytd: 0,
    };
    const out = subsidyForPayslip(ctx, SECOND_HALF);
    expect(out.adjustments_total).toBe(2000);
    expect(out.adjustment_ids).toEqual(["adj-1"]);
    expect(out.earnings).toEqual([expect.objectContaining({
      type: "subsidy_adjustment", amount: 2000, note: "Licensed teacher subsidy — adjustment (Oct 2026), approved by Hana HR",
    })]);
  });
});

describe("the five statuses and who did what", () => {
  const row = {
    id: "r1", kind: "adjustment", employee_id: "e1", subsidy_balance_id: "b1", status: "applied", amount: "2000.00",
    reason: "Verified late", details: { months_missed: 1, months_label: "Oct 2026" }, submission_no: 2,
    requested_by: "acct", requested_by_name: "Ana Accountant", requested_at: "2026-10-01T00:00:00Z",
    processed_by: "acct", processed_by_name: "Ana Accountant", processed_at: "2026-10-03T00:00:00Z",
    decided_by: "hr", decided_by_name: "Hana HR", decided_at: "2026-10-04T00:00:00Z", applied_note: "Paid on the Oct 16, 2026 payslip",
    history: [
      { action: "processed", actor_name: "Ana Accountant", at: "2026-10-01T00:00:00Z", note: "Verified late" },
      { action: "rejected", actor_name: "Hana HR", at: "2026-10-02T00:00:00Z", note: "Attach the receipt date." },
      { action: "resubmitted", actor_name: "Ana Accountant", at: "2026-10-03T00:00:00Z", note: "Receipt dated Oct 1" },
      { action: "approved", actor_name: "Hana HR", at: "2026-10-04T00:00:00Z", note: null },
      { action: "applied", actor_name: "Payroll", at: "2026-10-31T00:00:00Z", note: "Paid on the payslip from Oct 16, 2026" },
    ],
  };

  it("labels every status", () => {
    expect(SUBSIDY_STATUS_LABELS).toEqual({ pending: "Pending", processed: "Processed", approved: "Approved", rejected: "Rejected", applied: "Applied to payroll" });
  });

  it("shows requested, processed and decided by, and the last rejection", () => {
    const shaped = shapeSubsidyRequest(row, { employeeName: "Tess Teacher", year: "2026" });
    expect(shaped).toMatchObject({
      status_label: "Applied to payroll", amount: 2000, details_label: "Oct 2026 · 1 month",
      requested_by_name: "Ana Accountant", processed_by_name: "Ana Accountant", decided_by_name: "Hana HR",
      last_rejection: expect.objectContaining({ note: "Attach the receipt date." }),
    });
    // Raised by the system: no person requested it.
    expect(shapeSubsidyRequest({ ...row, requested_by: null, requested_by_name: "System" }).requested_by_name).toBe("System");
  });

  it("keeps every decision in the history, with who processed that round", () => {
    const history = decisionHistory([shapeSubsidyRequest(row, { employeeName: "Tess Teacher" })]);
    expect(history.map((h) => [h.decision_label, h.processed_by_name, h.decided_by_name, h.decided_at])).toEqual([
      ["Approved · Applied to payroll", "Ana Accountant", "Hana HR", "2026-10-04T00:00:00Z"],
      ["Rejected", "Ana Accountant", "Hana HR", "2026-10-02T00:00:00Z"],
    ]);
    expect(history[1].reason).toBe("Attach the receipt date.");
  });

  it("describes each kind", () => {
    expect(describeDetails({ kind: "advance", details: { date_granted: "2026-10-21", description: "Tuition" } })).toBe("Released 2026-10-21 · Tuition");
    expect(describeDetails({ kind: "excess_settlement", details: {} })).toBe("Not processed yet");
    expect(describeDetails({ kind: "excess_settlement", details: { option: "waive" } })).toBe("Waive (write off)");
  });
});

describe("database refusals reach the person", () => {
  it("maps the coded messages to statuses", () => {
    expect(describeSubsidyError({ message: "forbidden: only HR approves or rejects a subsidy." })).toMatchObject({ status: 403, error: "Only HR approves or rejects a subsidy." });
    expect(describeSubsidyError({ message: "invalid_transition: this request is rejected (only a processed one is decided)." })).toMatchObject({ status: 409 });
    expect(describeSubsidyError({ message: "remarks_required: write the reason." })).toMatchObject({ status: 400 });
    expect(describeSubsidyError({ code: "42501", message: "A subsidy advance is released only when HR approves it." })).toMatchObject({ status: 403 });
    expect(describeSubsidyError({ message: "Could not find the function public.subsidy_request_process" })).toMatchObject({ status: 503 });
  });
});

describe("advance limit", () => {
  it("is the remaining balance, or what was earned to date", () => {
    const balance = { remaining: 10000, advance_limit: "full_year", annual_amount: 24000, eligible_from: "2026-07-01", eligible_months: 6, advances_total: 2000, paid_out: 0 };
    expect(advanceAvailable(balance, "2026-09-10")).toBe(10000);
    // Jul–Sep earned = 6,000, less 2,000 already advanced.
    expect(advanceAvailable({ ...balance, advance_limit: "earned_to_date" }, "2026-09-10")).toBe(4000);
  });
});
