/**
 * First-sign-in password change, required employee fields, and the
 * first-tap / last-tap attendance rule.
 */

import { describe, it, expect } from "vitest";

process.env.SESSION_SECRET ||= "test-signing-secret-for-accounts-suite";

const {
  buildDefaultPassword,
  isDefaultPassword,
  hashTemporaryPassword,
  mustChangePassword,
  validateNewPassword,
  DEFAULT_PASSWORD_SYMBOL,
} = await import("@/lib/auth/password-policy");
const { normalizeEmployeeFields, validateEmployeeRecord } = await import("@/lib/employees/record");
const { collapseDailyTaps, planTap, DUPLICATE_TAP_WINDOW_MS } = await import("@/lib/attendance/taps");

describe("Default password detection", () => {
  const person = { full_name: "Juan Santos Dela Cruz Jr.", date_of_birth: "2004-10-08" };

  it("builds LastName + MMDDYYYY + the required symbol", () => {
    // The trailing symbol is required because Supabase Auth's own password
    // policy demands at least one symbol character — plain LastName+MMDDYYYY
    // fails account creation with a 422 without it (see DEFAULT_PASSWORD_SYMBOL
    // in src/lib/auth/password-policy.js).
    expect(buildDefaultPassword("dela cruz", "2004-10-08")).toBe(`DelaCruz10082004${DEFAULT_PASSWORD_SYMBOL}`);
    expect(buildDefaultPassword("Refuerzo", "2004-10-08")).toBe(`Refuerzo10082004${DEFAULT_PASSWORD_SYMBOL}`);
    expect(buildDefaultPassword("", "2004-10-08")).toBe("");
    expect(buildDefaultPassword("Cruz", "10/08/2004")).toBe("");
  });

  it("recognises the default for a multi-word last name and a suffix", () => {
    expect(isDefaultPassword(`DelaCruz10082004${DEFAULT_PASSWORD_SYMBOL}`, person)).toBe(true);
    expect(isDefaultPassword(`delacruz10082004${DEFAULT_PASSWORD_SYMBOL}`, person)).toBe(true);
    expect(isDefaultPassword(`Cruz10082004${DEFAULT_PASSWORD_SYMBOL}`, person)).toBe(true);
  });

  it("no longer recognises the pre-symbol shape as the default", () => {
    // Locks in the new contract: without the required symbol, this is not
    // (and never was issued as) the account's default password.
    expect(isDefaultPassword("DelaCruz10082004", person)).toBe(false);
  });

  it("does not flag a password the person chose", () => {
    expect(isDefaultPassword("DelaCruz10082005", person)).toBe(false);
    expect(isDefaultPassword("Sunflower2026", person)).toBe(false);
    expect(isDefaultPassword("Juan10082004", person)).toBe(false);
    expect(isDefaultPassword("DelaCruz10082004", { full_name: "Juan Dela Cruz" })).toBe(false);
  });

  it("forces a change when the issued one-time password is used, even after a name correction", () => {
    const user = {
      app_metadata: { temp_password_hash: hashTemporaryPassword("Refuerzo10082004") },
      user_metadata: { full_name: "Ehd Refuerso", date_of_birth: "2004-10-08" },
    };
    expect(mustChangePassword("Refuerzo10082004", user)).toBe(true);
    expect(mustChangePassword("MyOwnPass123", user)).toBe(false);
  });

  it("forces a change for an older account still on its default password", () => {
    const user = { app_metadata: {}, user_metadata: { full_name: "Cody Emerson", date_of_birth: "1999-01-15" } };
    const defaultPassword = `Emerson01151999${DEFAULT_PASSWORD_SYMBOL}`;
    expect(mustChangePassword(defaultPassword, user)).toBe(true);
    expect(mustChangePassword(defaultPassword, user, "Cody Emerson")).toBe(true);
    expect(mustChangePassword("NotDefault99", user)).toBe(false);
  });
});

describe("New password rules", () => {
  const person = { full_name: "Ehd Refuerzo", date_of_birth: "2004-10-08", currentPassword: "Refuerzo10082004#" };

  it("accepts a sound password", () => {
    expect(validateNewPassword("Payroll2026x!", person)).toBeNull();
  });

  it.each([
    ["short1", /at least 8/],
    ["onlyletters", /letters and numbers/],
    ["1234567890", /letters and numbers/],
    ["has space 123", /spaces/],
    ["payroll2026!", /uppercase/],
    ["Payroll2026", /symbol/],
    ["Refuerzo10082004#", /different from your current/],
  ])("rejects %s", (password, message) => {
    expect(validateNewPassword(password, person)).toMatch(message);
  });

  it("rejects re-using the default pattern even when it is not the current password", () => {
    expect(validateNewPassword(`Refuerzo10082004${DEFAULT_PASSWORD_SYMBOL}`, { ...person, currentPassword: "Something123!" }))
      .toMatch(/default password/);
  });
});

describe("Required employee fields", () => {
  const complete = {
    first_name: "Juan",
    middle_initial: "Santos",
    last_name: "Dela Cruz",
    email: "juan@example.com",
    date_of_birth: "1995-03-14",
    sex: "Male",
    civil_status: "Single",
    employee_type: "Teaching",
    employment_type: "Full-time",
    employment_status: "Probationary",
    employee_status: "Active",
    position: "Employee",
    date_hired: "2026-06-01",
    basic_salary: "18500",
    address: "123 Rizal St., Brgy. San Isidro, Antipolo City, Rizal",
    cp_number: "0917 123 4567",
    sss_number: "12-3456789-0",
    philhealth_number: "12-345678901-2",
    pagibig_number: "1234-5678-9012",
    tin_number: "123-456-789-000",
    bank_name: "BDO",
    bank_account_number: "001234567890",
    branch_id: "11111111-1111-1111-1111-111111111111",
  };
  const today = new Date("2026-09-16T00:00:00Z");
  const check = (overrides, creating = true) =>
    validateEmployeeRecord(normalizeEmployeeFields({ ...complete, ...overrides }), { creating, today });

  it("accepts a complete record", () => {
    expect(check({})).toBeNull();
    expect(check({ middle_initial: "", suffix: "" })).toBeNull();
    expect(check({ tin_number: "123456789" })).toBeNull();
  });

  it.each([
    "first_name", "last_name", "email", "date_of_birth", "sex", "civil_status", "employee_type",
    "employment_type", "employment_status", "employee_status", "position", "date_hired", "basic_salary",
    "address", "cp_number", "sss_number", "philhealth_number", "pagibig_number", "tin_number",
    "bank_name", "bank_account_number", "branch_id",
  ])("refuses to create an account without %s", (field) => {
    expect(check({ [field]: "" })).toMatch(/required field/);
  });

  it("does not require salary or branch on an edit (HR cannot change those)", () => {
    expect(check({ basic_salary: undefined, branch_id: "" }, false)).toBeNull();
  });

  it("rejects values outside the allowed option lists", () => {
    expect(check({ civil_status: "Complicated" })).toMatch(/Civil status/);
    expect(check({ employment_type: "Seasonal" })).toMatch(/Employment type/);
  });

  it.each([
    [{ cp_number: "0817 123 4567" }, /starting with 09/],
    [{ cp_number: "0917 123 456" }, /11-digit/],
    [{ sss_number: "12-345678-0" }, /SSS/],
    [{ philhealth_number: "1234" }, /PhilHealth/],
    [{ pagibig_number: "1234" }, /Pag-IBIG/],
    [{ tin_number: "1234567890" }, /TIN/],
    [{ bank_account_number: "123" }, /Bank account/],
    [{ basic_salary: "0" }, /Basic salary/],
    [{ date_of_birth: "2015-01-01" }, /at least 15/],
    [{ date_of_birth: "1995-02-31" }, /not a valid date/],
    [{ date_hired: "2000-01-01" }, /15th birthday/],
    [{ first_name: "Juan2" }, /letters and spaces/],
    [{ email: "juan@" }, /valid email/],
    [{ address: "Q" }, /complete home address/],
  ])("rejects %o", (overrides, message) => {
    expect(check(overrides)).toMatch(message);
  });
});

describe("RFID: only the first and last tap of the day count", () => {
  const at = (hhmmss) => `2026-09-16T${hhmmss}.000Z`;
  const row = (id, timeIn, timeOut = null, status = "Present") => ({
    id, employee_id: "e1", log_date: "2026-09-16", time_in: timeIn, time_out: timeOut, status,
  });

  it("records the first tap as Time In", () => {
    expect(planTap([], at("00:00:00"))).toEqual({ action: "time_in" });
  });

  it("ignores a repeated tap within the duplicate window", () => {
    const plan = planTap([row("r1", at("00:00:00"))], at("00:00:30"));
    expect(plan.action).toBe("duplicate");
    expect(DUPLICATE_TAP_WINDOW_MS).toBe(60_000);
  });

  it("moves Time Out to every later tap, keeping the first Time In", () => {
    const first = planTap([row("r1", at("00:00:00"))], at("09:00:00"));
    expect(first).toMatchObject({ action: "time_out", time_in: at("00:00:00") });
    expect(first.target.id).toBe("r1");

    const later = planTap([row("r1", at("00:00:00"), at("09:00:00"))], at("10:30:00"));
    expect(later).toMatchObject({ action: "time_out", time_in: at("00:00:00") });
  });

  it("measures the duplicate window from the latest tap, not the first", () => {
    const plan = planTap([row("r1", at("00:00:00"), at("09:00:00"))], at("09:00:20"));
    expect(plan.action).toBe("duplicate");
  });

  it("folds a day that older code split across rows into first-in / last-out", () => {
    const [day] = collapseDailyTaps([
      row("r2", at("09:30:00"), null, "Late"),
      row("r1", at("00:05:00"), at("04:00:00"), "Present"),
      row("r3", at("10:15:00"), null, "Late"),
    ]);
    expect(day).toMatchObject({
      id: "r1",
      status: "Present",
      time_in: at("00:05:00"),
      time_out: at("10:15:00"),
      total_hours: 10.17,
    });
  });

  it("keeps different employees and days apart", () => {
    const rows = collapseDailyTaps([
      row("a", at("00:00:00")),
      { ...row("b", at("00:01:00")), employee_id: "e2" },
      { ...row("c", "2026-09-15T00:00:00.000Z"), log_date: "2026-09-15" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].time_out).toBeNull();
  });
});
