/**
 * Loan and licensed-teacher subsidy lines on the payslip explanation
 * (src/lib/payroll/payslip-summary.js) and in the Accountant preview
 * (src/lib/portal/payroll-preview.js), so the preview's net matches the server.
 */
import { describe, expect, it } from "vitest";
import { buildDeductionBasis } from "@/lib/payroll/payslip-summary";
import { batchRowNet, semiExtras } from "@/lib/portal/payroll-preview";

describe("payslip loan line", () => {
  it("explains each loan amortization with its balance", () => {
    const lines = buildDeductionBasis({
      payroll: {
        deductions: { loan: 1500 },
        totals: {},
        loans: [
          { amount: 1000, description: "Salary loan", balance_after: 4000, shortfall: 0 },
          { amount: 500, description: "Emergency loan", balance_after: 0, shortfall: 250 },
        ],
      },
      auto: {},
      rates: {},
      legal: true,
    });
    const loan = lines.find((line) => line.type === "loan");
    expect(loan.amount).toBe(1500);
    expect(loan.basis).toBe("Loans: 1,000.00 (Salary loan), balance 4,000.00; 500.00 (Emergency loan), balance 0.00, partial = 1,500.00");
  });

  it("adds no line when nothing is deducted", () => {
    const lines = buildDeductionBasis({ payroll: { deductions: { loan: 0 }, totals: {}, loans: [] }, auto: {}, rates: {}, legal: true });
    expect(lines.find((line) => line.type === "loan")).toBeUndefined();
  });
});

describe("preview subsidy and loans", () => {
  it("reads the subsidy from the server defaults", () => {
    const extras = semiExtras({ row: { defaults: { subsidy_pay: 1250, subsidy_taxable: 0, carry_in: 0 } } });
    expect(extras.subsidy).toBe(1250);
    expect(extras.subsidyTaxable).toBe(0);
  });

  it("adds the subsidy and takes the loans in the batch net", () => {
    const net = batchRowNet({
      basic_salary: 20000, sss: 0, philhealth: 0, pagibig: 0, tax: 0,
      leave_without_pay_days: 0, daily_rate: 919.54, attendance_deductions: 0,
      incentives: 0, earnings: 0, other_incentives: 1250,
      first_half_paid: 10000, carry_in: 0, cash_advance: 1500,
    });
    expect(net).toBe(9750);
  });
});
