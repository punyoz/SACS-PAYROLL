/**
 * The Super Admin's staff-account form rules (src/lib/portal/staff-rules.js),
 * ported from SA_STAFF_RULES in public/legacy/js/super-admin.js. The server
 * repeats them; these keep the React form saying the same as the legacy one.
 */

import { describe, it, expect } from "vitest";
import { checkStaffFields, cleanStaffField, emergencySkipped, latestBirthDate } from "@/lib/portal/staff-rules";

const VALID_ADD = {
  first_name: "Juan", middle_name: "", last_name: "Dela Cruz", suffix: "", email: "juan@example.com", role: "admin",
  employee_status: "Active", branch_id: "b1", date_of_birth: "1990-05-01", date_hired: "2015-06-01", sex: "Male",
  civil_status: "Single", cp_number: "0917 123 4567", address: "12 Mabini St, Quezon City",
  emergency_contact_name: "Maria Dela Cruz", emergency_contact_relationship: "Spouse",
  emergency_contact_number: "0918 765 4321", emergency_contact_address: "45 Rizal Ave, Pasig City",
};
const ALL = Object.keys(VALID_ADD);

const failing = (errors) => Object.entries(errors).filter(([, m]) => m).map(([k]) => k);

describe("staff form rules", () => {
  it("accepts a complete Add Staff Account form", () => {
    expect(failing(checkStaffFields(ALL, VALID_ADD))).toEqual([]);
  });

  it("needs a branch only for an Admin", () => {
    expect(checkStaffFields(["branch_id"], { ...VALID_ADD, branch_id: "" }).branch_id).toBe("Select the branch this account belongs to.");
    expect(checkStaffFields(["branch_id"], { ...VALID_ADD, role: "hr", branch_id: "" }).branch_id).toBe("");
    expect(checkStaffFields(["branch_id"], { ...VALID_ADD, role: "super_admin", branch_id: "" }).branch_id).toBe("");
  });

  it("checks names, email, age and phone numbers", () => {
    const errors = checkStaffFields(ALL, {
      ...VALID_ADD,
      first_name: "-Juan",
      email: "juan@",
      date_of_birth: latestBirthDate().replace(/^\d{4}/, (y) => String(Number(y) + 1)),
      cp_number: "0817 123 4567",
    });
    expect(errors.first_name).toMatch(/start with a letter/);
    expect(errors.email).toMatch(/valid email/);
    expect(errors.date_of_birth).toBe("Must be at least 18 years old.");
    expect(errors.cp_number).toMatch(/starting with 09/);
    const same = checkStaffFields(["emergency_contact_number"], { ...VALID_ADD, emergency_contact_number: VALID_ADD.cp_number });
    expect(same.emergency_contact_number).toBe("Must differ from the account holder's own number.");
  });

  it("hire date must be on or after the 18th birthday", () => {
    expect(checkStaffFields(["date_hired"], { ...VALID_ADD, date_hired: "2007-01-01" }).date_hired).toBe("Must be on or after the 18th birthday.");
  });

  it("password is optional but strong when set", () => {
    expect(checkStaffFields(["password"], { password: "" }).password).toBe("");
    expect(checkStaffFields(["password"], { password: "abcdefgh1" }).password).toBe("Needs at least one uppercase letter.");
    expect(checkStaffFields(["password"], { password: "Abcdefgh1" }).password).toMatch(/symbol/);
    expect(checkStaffFields(["password"], { password: "Abcdefgh1!" }).password).toBe("");
  });

  it("Edit may leave a missing emergency contact blank, never a partial one", () => {
    const blank = { ...VALID_ADD, emergency_contact_name: "", emergency_contact_relationship: "", emergency_contact_number: "", emergency_contact_address: "" };
    expect(emergencySkipped(blank, { editing: true, ecOnFile: false })).toBe(true);
    expect(emergencySkipped(blank, { editing: true, ecOnFile: true })).toBe(false);
    expect(emergencySkipped(blank, { editing: false })).toBe(false);
    const partial = { ...blank, emergency_contact_name: "Maria" };
    expect(failing(checkStaffFields(["emergency_contact_relationship"], partial, { editing: true }))).toEqual(["emergency_contact_relationship"]);
  });
});

describe("live filtering", () => {
  it("drops characters a field cannot hold and says why", () => {
    expect(cleanStaffField("first_name", "Ju4n  ")).toEqual({ value: "Jun ", note: "Letters, spaces, hyphens, apostrophes and periods only." });
    expect(cleanStaffField("email", "Juan @Example.com").value).toBe("juan@example.com");
    expect(cleanStaffField("address", "12 Mabini St; QC").value).toBe("12 Mabini St QC");
    expect(cleanStaffField("last_name", "Cruz")).toEqual({ value: "Cruz", note: "" });
  });
});
