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

describe("final pay text (2026-11-20): pesos, dates and months in words", async () => {
  const { dateTimeText, lineLabel, monthText, pesoText, rangeText } = await import("@/lib/payroll/final-pay-text");
  const { computeFinalPay } = await import("@/lib/payroll/final-pay");

  it("formats pesos, months, ranges and times", () => {
    expect(pesoText(14069.03)).toBe("₱14,069.03");
    expect(pesoText(-600)).toBe("-₱600.00");
    expect(monthText("2026-10")).toBe("October 2026");
    expect(lineLabel("SSS", "2026-10")).toBe("SSS (October 2026)");
    expect(rangeText("2026-10-01", "2026-10-25")).toBe("Oct 1–25, 2026");
    expect(rangeText("2026-10-30", "2026-11-10")).toBe("Oct 30 – Nov 10, 2026");
    expect(dateTimeText("2026-11-19T13:45:00Z")).toBe("Nov 19, 2026, 9:45 PM");
  });

  it("writes readable formulas on the final pay lines (amounts unchanged)", () => {
    const r = computeFinalPay({
      monthlySalary: 18000, dailyRate: 827.59, separatedOn: "2026-10-25",
      months: [{ month_key: "2026-10", window: { start_key: "2026-10-01", end_key: "2026-10-29" }, absent_days: 0, first_half_paid: 0, partial: { paid: 17, unpaid_holidays: [] } }],
      contributions: { sss: 900, philhealth: 450, pagibig: 200 }, taxTable: [{ over: 0, base: 0, rate: 0 }],
      basicEarnedYtd: 0, thirteenthPaid: false, subsidy: null, benefitsYtd: 0, ceiling: 90000, carryIn: 0,
      loans: [{ id: "l1", loan_type: "salary_loan", description: "Salary loan, granted Sep 1, 2026", remaining_balance: 3000, final_pay_authorized: true, date_granted: "2026-09-01" }],
    });
    const salary = r.earnings.find((e) => e.kind === "salary");
    expect(salary.amount).toBe(14069.03);
    expect(salary.note).toBe("17 paid days × ₱827.59 (Oct 1–25, 2026)");
    expect(r.earnings.find((e) => e.kind === "thirteenth_month").note).toBe("₱14,069.03 ÷ 12");
    const loan = r.deductions.find((d) => d.kind === "loan");
    expect(loan).toMatchObject({ label: "Salary loan balance", note: "Salary loan, granted Sep 1, 2026 · balance ₱3,000.00", amount: 3000 });
    expect(JSON.stringify(r.earnings.map((e) => e.note))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
