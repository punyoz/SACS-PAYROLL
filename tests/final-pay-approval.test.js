// Final pay HR approval (20261120010000): the deadline, the labels and the refusals the screens show.
import { describe, expect, it } from "vitest";
import { LEGACY_LABEL, deadlineOf, describeDecideError, shapeSubmission } from "@/lib/payroll/final-pay-approval";

describe("final pay approval helpers", () => {
  it("counts the 30-day deadline (DOLE Labor Advisory 06-2020) to the day, overdue below zero", () => {
    expect(deadlineOf("2026-11-10", "2026-11-19")).toEqual({ deadline: "2026-12-10", days_left: 21 });
    expect(deadlineOf("2026-10-25", "2026-11-19")).toEqual({ deadline: "2026-11-24", days_left: 5 });
    expect(deadlineOf("2026-10-01", "2026-11-19")).toEqual({ deadline: "2026-10-31", days_left: -19 });
    expect(deadlineOf("2026-02-01", "2026-03-03").days_left).toBe(0); // across a 28-day February
  });

  it("labels each state; the final pay saved before the rule says so", () => {
    expect(shapeSubmission({ status: "pending", net_pay: "10.5" })).toMatchObject({ status_label: "Pending HR Approval", net_pay: 10.5 });
    expect(shapeSubmission({ status: "approved" }).status_label).toBe("Paid/Released");
    expect(shapeSubmission({ status: "rejected", reject_reason: "Clearance missing" })).toMatchObject({ status_label: "Rejected by HR", reject_reason: "Clearance missing" });
    expect(shapeSubmission({ status: "approved", legacy: true }).status_label).toBe(LEGACY_LABEL);
    expect(shapeSubmission(null)).toBeNull();
  });

  it("turns the database refusals into the right status and words", () => {
    expect(describeDecideError({ message: "forbidden: only HR of the employee's branch approves final pay." })).toEqual({ status: 403, error: "only HR of the employee's branch approves final pay." });
    expect(describeDecideError({ message: "reason_required: give the reason" }).status).toBe(400);
    expect(describeDecideError({ message: "invalid_transition: this final pay is approved already." }).status).toBe(409);
    expect(describeDecideError({ message: "connection reset" })).toEqual({ status: 500, error: "The final pay could not be decided. Try again." });
  });
});
