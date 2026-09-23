/**
 * Creating Super Admin / Admin / HR accounts.
 *
 * Two things are checked here: the pure record rules (real assertions against
 * the real validator), and the guarantees that live in the route's wiring --
 * read as text, matching tests/login-otp-flow.test.js, because importing the
 * route module would need live Supabase env values and would fire a real
 * network call the moment its POST handler ran.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeStaffFields,
  validateStaffRecord,
  lastNameFromFullName,
  STAFF_ROLES,
  STAFF_REQUIRED_FIELDS,
} from "@/lib/employees/staff-record";
import { canManageRole } from "@/lib/rbac/permissions";
import { buildDefaultPassword, isDefaultPassword } from "@/lib/auth/password-policy";

const staffRoute = readFileSync("src/app/api/admin/staff-accounts/route.js", "utf8");
const proxySource = readFileSync("src/proxy.js", "utf8");
const superAdminPage = readFileSync("public/legacy/pages/super-admin.html", "utf8");

/** A complete, valid staff record, so each test can vary one field. */
function validBody(overrides = {}) {
  return {
    full_name: "Maria Santos",
    email: "maria.santos@example.com",
    role: "hr",
    branch_id: "11111111-1111-1111-1111-111111111111",
    date_of_birth: "1990-04-12",
    sex: "Female",
    civil_status: "Single",
    date_hired: "2020-06-01",
    employee_status: "Active",
    address: "12 Mabini St, Quezon City",
    cp_number: "09171234567",
    ...overrides,
  };
}

/* ══ Super Admin may create all three staff roles ══════════════════════════ */

describe("Super Admin can create Super Admin, Admin and HR accounts", () => {
  it("the matrix permits all three targets", () => {
    for (const role of ["super_admin", "admin", "hr"]) {
      expect(canManageRole("super_admin", role)).toBe(true);
    }
  });

  it("all three pass record validation", () => {
    for (const role of STAFF_ROLES) {
      // Super Admin is branch-exempt, so it validates without a branch.
      const body = validBody({ role, branch_id: role === "super_admin" ? "" : validBody().branch_id });
      expect(validateStaffRecord(normalizeStaffFields(body))).toBeNull();
    }
  });

  it("rejects any role outside the three", () => {
    for (const role of ["employee", "accountant", "", "root"]) {
      const error = validateStaffRecord(normalizeStaffFields(validBody({ role })));
      expect(error).not.toBeNull();
    }
  });
});

/* ══ Only Super Admin may reach the flow ═══════════════════════════════════ */

describe("Admin and HR cannot create a Super Admin account", () => {
  it("neither may manage a super_admin through the matrix", () => {
    expect(canManageRole("admin", "super_admin")).toBe(false);
    expect(canManageRole("hr", "super_admin")).toBe(false);
    // HR's real ceiling is employee + accountant, and admin manages nobody.
    expect(canManageRole("hr", "admin")).toBe(false);
    expect(canManageRole("hr", "hr")).toBe(false);
  });

  it("the route refuses any caller that is not a super_admin", () => {
    // HR holds user_management for its own accounts, so the module check
    // alone would not stop it -- this explicit check is what does.
    expect(staffRoute).toMatch(/guard\.role\s*!==\s*"super_admin"/);
    const checkIdx = staffRoute.indexOf('guard.role !== "super_admin"');
    const createIdx = staffRoute.indexOf("supabase.auth.admin.createUser");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(checkIdx);
  });

  it("still runs the role-escalation check on the specific target role", () => {
    expect(staffRoute).toMatch(/denyRoleEscalation\(guard,\s*record\.role\)/);
  });

  it("the proxy maps the path, so it cannot ship unguarded", () => {
    // An unmapped /api path fails closed with a 403, but mapping it keeps the
    // refusal at the module level where the rest of the app's is.
    expect(proxySource).toMatch(/\["\/api\/admin\/staff-accounts",\s*"user_management"\]/);
  });
});

/* ══ Excluded fields ═══════════════════════════════════════════════════════ */

describe("Staff accounts carry no payroll or statutory fields", () => {
  const forbidden = [
    "basic_salary", "sss_number", "philhealth_number",
    "pagibig_number", "tin_number", "bank_name", "bank_account_number",
  ];

  it("the normaliser drops them even when a caller sends them", () => {
    const record = normalizeStaffFields(validBody({
      basic_salary: 50000,
      sss_number: "1234567890",
      philhealth_number: "1234567890",
      pagibig_number: "1234567890",
      tin_number: "123456789",
      bank_name: "BDO",
      bank_account_number: "1234567890",
    }));
    for (const field of forbidden) {
      expect(record).not.toHaveProperty(field);
    }
  });

  it("none of them is required", () => {
    for (const field of forbidden) {
      expect(STAFF_REQUIRED_FIELDS).not.toContain(field);
    }
  });

  it("the route never writes them to the account", () => {
    for (const field of forbidden) {
      expect(staffRoute).not.toContain(field + ":");
    }
  });

  it("does not collect a position either", () => {
    // Not a payroll field, so it gets its own check: the role IS the job for
    // these accounts, and normalizePositionForRole() derives the displayed
    // title from the role regardless of what was stored.
    expect(normalizeStaffFields(validBody({ position: "HR Officer" }))).not.toHaveProperty("position");
    expect(STAFF_REQUIRED_FIELDS).not.toContain("position");
    const formStart = superAdminPage.indexOf('id="sa-staff-account-form"');
    const form = superAdminPage.slice(formStart, superAdminPage.indexOf("</form>", formStart));
    expect(form).not.toContain('name="position"');
  });

  it("the Super Admin form has no input for them", () => {
    const formStart = superAdminPage.indexOf('id="sa-staff-account-form"');
    expect(formStart).toBeGreaterThan(-1);
    const form = superAdminPage.slice(formStart, superAdminPage.indexOf("</form>", formStart));
    for (const field of forbidden) {
      expect(form).not.toContain('name="' + field + '"');
    }
  });
});

/* ══ Issued default password + forced change ═══════════════════════════════ */

describe("A new staff account is issued a default password it must replace", () => {
  it("recovers the last name a single Full Name box hides", () => {
    expect(lastNameFromFullName("Maria Santos")).toBe("Santos");
    expect(lastNameFromFullName("Juan Dela Cruz")).toBe("Cruz");
    expect(lastNameFromFullName("Jose Rizal Jr.")).toBe("Rizal");
    expect(lastNameFromFullName("Cher")).toBe("Cher");
    expect(lastNameFromFullName("")).toBe("");
  });

  it("the generated password is recognised as the default at sign-in", () => {
    // The round trip that matters: what the route generates must be what
    // mustChangePassword() later identifies, or the holder is never forced to
    // change it.
    const fullName = "Juan Dela Cruz";
    const dob = "1990-04-12";
    const password = buildDefaultPassword(lastNameFromFullName(fullName), dob);
    expect(password).toBe("Cruz04121990!");
    expect(isDefaultPassword(password, { full_name: fullName, date_of_birth: dob })).toBe(true);
  });

  it("the route issues that password rather than accepting one", () => {
    expect(staffRoute).toMatch(/buildDefaultPassword\(lastNameFromFullName\(record\.full_name\)/);
    // No password is read from the request body at all.
    expect(staffRoute).not.toMatch(/body\.password/);
  });

  it("the route marks it one-time so first sign-in forces a change", () => {
    expect(staffRoute).toMatch(/temp_password_hash:\s*hashTemporaryPassword\(password\)/);
  });

  it("date of birth is required, since the password is built from it", () => {
    expect(STAFF_REQUIRED_FIELDS).toContain("date_of_birth");
    const error = validateStaffRecord(normalizeStaffFields(validBody({ date_of_birth: "" })));
    expect(error).toMatch(/date of birth/i);
  });
});

/* ══ Record rules ══════════════════════════════════════════════════════════ */

describe("Staff record validation", () => {
  it("accepts a complete record", () => {
    expect(validateStaffRecord(normalizeStaffFields(validBody()))).toBeNull();
  });

  it("requires a branch for Admin and HR but not for Super Admin", () => {
    for (const role of ["admin", "hr"]) {
      const error = validateStaffRecord(normalizeStaffFields(validBody({ role, branch_id: "" })));
      expect(error).toMatch(/branch/i);
    }
    const superAdmin = validateStaffRecord(
      normalizeStaffFields(validBody({ role: "super_admin", branch_id: "" })),
    );
    expect(superAdmin).toBeNull();
  });

  it("names every missing required field", () => {
    for (const field of STAFF_REQUIRED_FIELDS) {
      const error = validateStaffRecord(normalizeStaffFields(validBody({ [field]: "" })));
      expect(error).not.toBeNull();
    }
  });

  it("rejects an impossible date of birth", () => {
    const error = validateStaffRecord(normalizeStaffFields(validBody({ date_of_birth: "2026-02-31" })));
    expect(error).not.toBeNull();
  });

  it("rejects an under-age account holder", () => {
    const year = new Date().getUTCFullYear();
    const error = validateStaffRecord(normalizeStaffFields(validBody({
      date_of_birth: (year - 10) + "-01-01",
      date_hired: year + "-01-01",
    })));
    expect(error).toMatch(/15 years old/);
  });

  it("rejects a hire date before the holder could legally work", () => {
    const error = validateStaffRecord(normalizeStaffFields(validBody({
      date_of_birth: "1990-04-12",
      date_hired: "2000-06-01",
    })));
    expect(error).toMatch(/15th birthday/);
  });

  it("rejects a malformed email and a non-letter name", () => {
    expect(validateStaffRecord(normalizeStaffFields(validBody({ email: "not-an-email" })))).toMatch(/email/i);
    expect(validateStaffRecord(normalizeStaffFields(validBody({ full_name: "Maria 123" })))).toMatch(/letters/i);
  });

  it("strips non-digits from the contact number and bounds its length", () => {
    expect(normalizeStaffFields(validBody({ cp_number: "0917-123-4567" })).cp_number).toBe("09171234567");
    expect(validateStaffRecord(normalizeStaffFields(validBody({ cp_number: "12" })))).toMatch(/contact number/i);
  });
});
