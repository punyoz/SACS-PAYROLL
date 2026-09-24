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
  splitFullName,
  composeFullName,
  STAFF_ROLES,
  STAFF_REQUIRED_FIELDS,
} from "@/lib/employees/staff-record";
import { canManageRole } from "@/lib/rbac/permissions";
import { buildDefaultPassword, isDefaultPassword } from "@/lib/auth/password-policy";

const staffRoute = readFileSync("src/app/api/admin/staff-accounts/route.js", "utf8");
const proxySource = readFileSync("src/proxy.js", "utf8");
const superAdminPage = readFileSync("public/legacy/pages/super-admin.html", "utf8");
const superAdminScript = readFileSync("public/legacy/js/super-admin.js", "utf8");
const usersRoute = readFileSync("src/app/api/admin/users/route.js", "utf8");

/** A complete, valid staff record, so each test can vary one field. */
function validBody(overrides = {}) {
  return {
    first_name: "Maria",
    middle_name: "Lopez",
    last_name: "Santos",
    suffix: "",
    email: "maria.santos@example.com",
    role: "admin",
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
      // Only Admin carries a branch.
      const body = validBody({ role, branch_id: role === "admin" ? validBody().branch_id : "" });
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
  it("the generated password is recognised as the default at sign-in", () => {
    // The round trip that matters: what the route generates must be what
    // mustChangePassword() later identifies, or the holder is never forced to
    // change it. A two-word last name now reaches the password whole.
    const record = normalizeStaffFields(validBody({ first_name: "Juan", middle_name: "", last_name: "Dela Cruz" }));
    const dob = "1990-04-12";
    const password = buildDefaultPassword(record.last_name, dob);
    expect(password).toBe("DelaCruz04121990!");
    expect(isDefaultPassword(password, { full_name: record.full_name, date_of_birth: dob })).toBe(true);
  });

  it("the route issues that password rather than accepting one", () => {
    expect(staffRoute).toMatch(/buildDefaultPassword\(record\.last_name,\s*record\.date_of_birth\)/);
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

  it("requires a branch for Admin only; HR and Super Admin serve every branch", () => {
    const admin = validateStaffRecord(normalizeStaffFields(validBody({ role: "admin", branch_id: "" })));
    expect(admin).toMatch(/branch/i);
    for (const role of ["hr", "super_admin"]) {
      expect(validateStaffRecord(normalizeStaffFields(validBody({ role, branch_id: "" })))).toBeNull();
    }
  });

  it("the route stores HR and Super Admin with no branch", () => {
    expect(staffRoute).toMatch(/STAFF_BRANCH_REQUIRED_ROLES\.includes\(record\.role\)[\s\S]*?:\s*null/);
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
    expect(error).toMatch(/18 years old/);
  });

  it("rejects a 17-year-old", () => {
    const today = new Date();
    const dob = new Date(Date.UTC(today.getUTCFullYear() - 17, 0, 1)).toISOString().slice(0, 10);
    expect(validateStaffRecord(normalizeStaffFields(validBody({ date_of_birth: dob })))).toMatch(/18 years old/);
  });

  it("rejects a future date of birth", () => {
    const next = new Date().getUTCFullYear() + 1;
    expect(validateStaffRecord(normalizeStaffFields(validBody({ date_of_birth: next + "-01-01" })))).not.toBeNull();
  });

  it("rejects a hire date before the holder turned 18", () => {
    const error = validateStaffRecord(normalizeStaffFields(validBody({
      date_of_birth: "1990-04-12",
      date_hired: "2005-06-01",
    })));
    expect(error).toMatch(/18th birthday/);
  });

  it("rejects a malformed email, and emails with spaces or over 254 characters", () => {
    for (const email of ["not-an-email", "a b@example.com", "x@y", `${"a".repeat(250)}@example.com`]) {
      expect(validateStaffRecord(normalizeStaffFields(validBody({ email }))), email).toMatch(/email/i);
    }
    // Stored lowercase.
    expect(normalizeStaffFields(validBody({ email: "Maria@Example.COM" })).email).toBe("maria@example.com");
  });

  it("allows letters, spaces, hyphens, apostrophes and periods in names, and nothing else", () => {
    for (const last_name of ["O'Brien", "Santos-Reyes", "Dela Cruz", "Peñaflor", "St. John"]) {
      expect(validateStaffRecord(normalizeStaffFields(validBody({ last_name }))), last_name).toBeNull();
    }
    for (const first_name of ["Maria2", "Maria_", "Maria@", "-Maria"]) {
      expect(validateStaffRecord(normalizeStaffFields(validBody({ first_name }))), first_name).not.toBeNull();
    }
    expect(validateStaffRecord(normalizeStaffFields(validBody({ first_name: "A".repeat(51) })))).toMatch(/50/);
  });

  it("middle name and suffix are optional; an unknown suffix is refused", () => {
    expect(validateStaffRecord(normalizeStaffFields(validBody({ middle_name: "", suffix: "" })))).toBeNull();
    expect(validateStaffRecord(normalizeStaffFields(validBody({ suffix: "Esq." })))).toMatch(/suffix/i);
    expect(normalizeStaffFields(validBody({ suffix: "jr" })).suffix).toBe("Jr.");
  });

  it("requires an 11-digit mobile number starting with 09", () => {
    expect(normalizeStaffFields(validBody({ cp_number: "0917 123 4567" })).cp_number).toBe("09171234567");
    for (const cp_number of ["12", "0917123456", "08171234567", "091712345678"]) {
      expect(validateStaffRecord(normalizeStaffFields(validBody({ cp_number }))), cp_number).toMatch(/contact number/i);
    }
  });

  it("limits the address to letters, numbers, spaces and , . - # /", () => {
    expect(validateStaffRecord(normalizeStaffFields(validBody({ address: "Unit 4-B #12 Mabini St., Brgy. 5/6, QC" })))).toBeNull();
    expect(validateStaffRecord(normalizeStaffFields(validBody({ address: "12 Mabini St; <script>" })))).toMatch(/address/i);
    expect(validateStaffRecord(normalizeStaffFields(validBody({ address: "x".repeat(161) })))).toMatch(/160/);
  });
});

/* ══ Split name fields ═════════════════════════════════════════════════════ */

describe("Staff names are stored split, with a composed full name", () => {
  it("composes First Middle Last Suffix, skipping blanks", () => {
    expect(composeFullName({ first_name: "Juan", middle_name: "", last_name: "Dela Cruz", suffix: "Jr." }))
      .toBe("Juan Dela Cruz Jr.");
    expect(normalizeStaffFields(validBody()).full_name).toBe("Maria Lopez Santos");
  });

  it("splits an existing full name the same way the migration does", () => {
    expect(splitFullName("Juan Santos Dela Cruz Jr.")).toEqual({
      first_name: "Juan", middle_name: "Santos", last_name: "Dela Cruz", suffix: "Jr.",
    });
    expect(splitFullName("Maria Santos")).toEqual({
      first_name: "Maria", middle_name: "", last_name: "Santos", suffix: "",
    });
    expect(splitFullName("Juan De Los Santos")).toMatchObject({ first_name: "Juan", last_name: "De Los Santos" });
    expect(splitFullName("Cher")).toMatchObject({ first_name: "Cher", last_name: "" });
  });

  it("still accepts a caller that sends only full_name", () => {
    const record = normalizeStaffFields({ ...validBody(), first_name: undefined, middle_name: undefined, last_name: undefined, suffix: undefined, full_name: "Ana Reyes" });
    expect(record).toMatchObject({ first_name: "Ana", last_name: "Reyes", full_name: "Ana Reyes" });
  });

  it("the route writes the parts to profiles", () => {
    for (const column of ["first_name:", "middle_name:", "last_name:", "suffix:"]) {
      expect(staffRoute).toContain(column);
    }
  });

  it("both Super Admin forms collect four name fields instead of one", () => {
    for (const formId of ["sa-staff-account-form", "sa-admin-user-form"]) {
      const start = superAdminPage.indexOf(`id="${formId}"`);
      const form = superAdminPage.slice(start, superAdminPage.indexOf("</form>", start));
      for (const name of ["first_name", "middle_name", "last_name", "suffix"]) {
        expect(form, `${formId} ${name}`).toContain(`name="${name}"`);
      }
      expect(form, formId).not.toContain('name="full_name"');
    }
  });
});

/* ══ Quick Add is gone ═════════════════════════════════════════════════════ */

describe("Quick Add has been removed", () => {
  it("has no button, and the Edit dialog no longer creates accounts", () => {
    expect(superAdminPage).not.toMatch(/Quick Add/i);
    expect(superAdminPage).not.toContain("openSAAdminUserModal()");
    expect(superAdminScript).not.toMatch(/method:\s*'POST',[^}]*\n[^}]*\/api\/admin\/users|fetch\('\/api\/admin\/users',\s*\{\s*method:\s*'POST'/);
  });

  it("/api/admin/users no longer has a POST handler", () => {
    expect(usersRoute).not.toMatch(/export async function POST/);
    expect(usersRoute).toMatch(/export async function PATCH/);
  });
});
