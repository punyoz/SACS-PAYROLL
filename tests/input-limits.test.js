import { describe, expect, it } from "vitest";
import {
  BRANCH_NAME_PATTERN, CASH_ADVANCE_MAX, LOAN_MAX, RFID_UID_PATTERN, SALARY_MAX,
  digitsOrNull, pesoLimit, textLimitError,
} from "@/lib/input-limits";
import { normalizeEmployeeFields, validateEmployeePatch, validateEmployeeRecord } from "@/lib/employees/record";
import { validateLoanInput } from "@/lib/payroll/loans";
import { validateCashAdvanceInput } from "@/lib/payroll/cash-advance";
import { validateSalaryChange } from "@/lib/employees/salary-history";
import { isCardUid } from "@/lib/rfid/cards";
import { isPersonName } from "@/lib/person-name";

const TODAY = new Date(Date.UTC(2026, 9, 29));
const RECORD = {
  first_name: "Juan", last_name: "Dela Cruz", email: "juan.delacruz@example.com", date_of_birth: "1990-01-01",
  sex: "Male", civil_status: "Single", employee_type: "Teaching", employment_type: "Full-time",
  employment_status: "Regular", employee_status: "Active", position: "Employee", date_hired: "2020-06-01",
  basic_salary: 25000, address: "123 Rizal St, Antipolo", cp_number: "09171234567",
  sss_number: "12-3456789-0", philhealth_number: "123456789012", pagibig_number: "1234-5678-9012",
  tin_number: "123-456-789", branch_id: "b1",
};
const check = (overrides) => validateEmployeeRecord(normalizeEmployeeFields({ ...RECORD, ...overrides }), { creating: true, today: TODAY });

describe("digitsOrNull", () => {
  it("keeps digits, drops dashes and spaces", () => {
    expect(digitsOrNull("12-3456789-0")).toBe("1234567890");
    expect(digitsOrNull("0917 123 4567")).toBe("09171234567");
  });
  it("refuses letters and symbols instead of dropping them", () => {
    expect(digitsOrNull("12a4567890")).toBeNull();
    expect(digitsOrNull("abcde")).toBeNull();
    expect(digitsOrNull("+639171234567")).toBeNull();
  });
});

describe("employee record", () => {
  it("accepts a real record with dashed government numbers", () => {
    expect(check({})).toBeNull();
  });
  it("refuses letters in a number field rather than stripping them", () => {
    expect(check({ sss_number: "12a456789b0" })).toBe("SSS number may contain digits only.");
    expect(check({ cp_number: "0917abc4567" })).toBe("Contact number may contain digits only.");
  });
  it("refuses a suffix outside the list instead of dropping it", () => {
    expect(check({ suffix: "Jr." })).toBeNull();
    expect(check({ suffix: "Esquire the Third" })).toMatch(/Suffix must be one of/);
  });
  it("keeps the salary to ₱1,000,000", () => {
    expect(check({ basic_salary: SALARY_MAX })).toBeNull();
    expect(check({ basic_salary: SALARY_MAX + 0.01 })).toMatch(/at most ₱1,000,000/);
  });
  it("accepts a TIN of 9, 12 or 14 digits, and no other length", () => {
    for (const tin of ["123-456-789", "123-456-789-000", "123-456-789-00000"]) expect(check({ tin_number: tin })).toBeNull();
    for (const tin of ["12345678", "1234567890", "1234567890123", "123456789000000"]) expect(check({ tin_number: tin })).toMatch(/9, 12 or 14/);
    expect(validateEmployeePatch({ tin_number: "12345678900000" })).toBeNull();
  });
  it("caps the email at 254 characters", () => {
    expect(check({ email: `${"a".repeat(245)}@ex.com` })).toBeNull();
    expect(check({ email: `${"a".repeat(250)}@ex.com` })).toMatch(/at most 254/);
  });
  it("allows real Filipino names", () => {
    for (const name of ["Dela Peña", "D'Angelo", "Ma. Theresa", "Santos-Reyes", "Ibáñez"]) expect(isPersonName(name)).toBe(true);
    expect(isPersonName("Ana2")).toBe(false);
  });
});

describe("employee edit (PATCH)", () => {
  it("checks only the fields sent", () => {
    expect(validateEmployeePatch({ full_name: "Juan Dela Cruz" })).toBeNull();
  });
  it("refuses a too-long or lettered government number instead of cutting it", () => {
    expect(validateEmployeePatch({ sss_number: "123456789012345" })).toBe("SSS number must be exactly 10 digits.");
    expect(validateEmployeePatch({ tin_number: "12345678x" })).toBe("TIN may contain digits only.");
    expect(validateEmployeePatch({ cp_number: "0817123456" })).toMatch(/11-digit/);
  });
  it("lets a blank government number clear it", () => {
    expect(validateEmployeePatch({ sss_number: "" })).toBeNull();
  });
});

describe("peso limits", () => {
  const loan = { loan_type: "salary_loan", principal: LOAN_MAX, interest_pct: 0, number_of_payrolls: 10, amortization: LOAN_MAX / 10, date_granted: "2026-10-01", start_period: "2026-10-16" };
  it("caps a loan at ₱500,000 and a cash-advance loan at ₱50,000", () => {
    expect(validateLoanInput(loan)).toBeNull();
    expect(validateLoanInput({ ...loan, principal: LOAN_MAX + 1 })).toMatch(/at most ₱500,000/);
    expect(validateLoanInput({ ...loan, loan_type: "cash_advance", principal: CASH_ADVANCE_MAX + 1, amortization: 1000 })).toMatch(/at most ₱50,000/);
    expect(validateLoanInput({ ...loan, principal: "abc" })).toMatch(/more than 0/);
  });
  it("caps a cash advance at ₱50,000", () => {
    const advance = { principal: CASH_ADVANCE_MAX, installment_amount: 1000, deduct_on: "both", date_granted: "2026-10-01", start_date: "2026-10-16" };
    expect(validateCashAdvanceInput(advance)).toBeNull();
    expect(validateCashAdvanceInput({ ...advance, principal: 50000.01 })).toMatch(/at most ₱50,000/);
  });
  it("caps a salary change and its note", () => {
    const change = { new_salary: 30000, effective_date: "2027-01-01", reason: "Promotion", note: "x".repeat(500) };
    expect(validateSalaryChange(change, { todayKey: "2026-10-29" })).toBeNull();
    expect(validateSalaryChange({ ...change, note: "x".repeat(501) }, { todayKey: "2026-10-29" })).toMatch(/at most 500/);
    expect(validateSalaryChange({ ...change, new_salary: 1000001 }, { todayKey: "2026-10-29" })).toMatch(/₱1,000,000/);
  });
  it("formats limits for messages", () => {
    expect(pesoLimit(1_000_000)).toBe("₱1,000,000");
    expect(pesoLimit(999_999.99)).toBe("₱999,999.99");
  });
});

describe("identifiers and text", () => {
  it("takes an RFID card number of exactly 10 digits", () => {
    expect(isCardUid("0001234567")).toBe(true);
    expect(RFID_UID_PATTERN.test("123456789")).toBe(false);
    expect(isCardUid("12345678901")).toBe(false);
    expect(isCardUid("00012345AB")).toBe(false);
  });
  it("allows real branch names and refuses symbols", () => {
    for (const name of ["Main Branch", "Sto. Niño Annex", "Phase 2-B", "San Jose del Monte"]) expect(BRANCH_NAME_PATTERN.test(name)).toBe(true);
    for (const name of ["Main <script>", "Branch #1", "-Main"]) expect(BRANCH_NAME_PATTERN.test(name)).toBe(false);
  });
  it("reports the first over-long text field", () => {
    const caps = { reason: [500, "The reason"], note: [1000, "The note"] };
    expect(textLimitError({ reason: "x".repeat(500), note: "y" }, caps)).toBeNull();
    expect(textLimitError({ reason: "x".repeat(501) }, caps)).toBe("The reason can be at most 500 characters.");
    expect(textLimitError({ note: "y".repeat(1001) }, caps)).toBe("The note can be at most 1,000 characters.");
    expect(textLimitError(undefined, caps)).toBeNull();
  });
});
