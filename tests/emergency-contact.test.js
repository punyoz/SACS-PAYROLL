/**
 * Emergency contact on new accounts.
 *
 * The validator is tested directly; the wiring (both create routes call it
 * before creating the auth user, and both forms send the fields) is read as
 * text, as tests/staff-accounts.test.js does, because importing a route would
 * need live Supabase env values.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EMERGENCY_RELATIONSHIP_OPTIONS,
  emergencyContactColumns,
  normalizeEmergencyContact,
  validateEmergencyContact,
  validateEmergencyContactUpdate,
} from "@/lib/employees/emergency-contact";

const OWN_NUMBER = "09171234567";

function contact(overrides = {}) {
  return normalizeEmergencyContact({
    emergency_contact_name: "Maria Dela Cruz",
    emergency_contact_relationship: "Parent",
    emergency_contact_address: "45 Rizal Ave, Pasig City",
    emergency_contact_number: "0918 765 4321",
    ...overrides,
  });
}

describe("validateEmergencyContact", () => {
  it("accepts a complete contact and normalises it", () => {
    const c = contact({ emergency_contact_relationship: "parent", emergency_contact_name: "  Maria   Dela Cruz " });
    expect(validateEmergencyContact(c, OWN_NUMBER)).toBeNull();
    expect(c).toEqual({
      emergency_contact_name: "Maria Dela Cruz",
      emergency_contact_relationship: "Parent",
      emergency_contact_address: "45 Rizal Ave, Pasig City",
      emergency_contact_number: "09187654321",
    });
  });

  it.each([
    ["emergency_contact_name", "", /name is required/],
    ["emergency_contact_name", "Maria 2", /letters, spaces/],
    ["emergency_contact_relationship", "Neighbour", /relationship/],
    ["emergency_contact_address", "", /address is required/],
    ["emergency_contact_address", "Pasi", /complete address/],
    ["emergency_contact_number", "", /number is required/],
    ["emergency_contact_number", "0918765432", /11-digit/],
    ["emergency_contact_number", "08187654321", /11-digit/],
  ])("rejects %s = %j", (field, value, message) => {
    expect(validateEmergencyContact(contact({ [field]: value }), OWN_NUMBER)).toMatch(message);
  });

  it("refuses the account holder's own number", () => {
    expect(validateEmergencyContact(contact({ emergency_contact_number: OWN_NUMBER }), OWN_NUMBER))
      .toMatch(/different/);
  });

  it("matches the relationship list the database allows", () => {
    const migration = readFileSync("supabase/migrations/20260924134806_profiles_emergency_contact.sql", "utf8");
    EMERGENCY_RELATIONSHIP_OPTIONS.forEach((option) => expect(migration).toContain(`'${option}'`));
  });

  it("maps to profiles columns", () => {
    expect(Object.keys(emergencyContactColumns(contact()))).toEqual([
      "emergency_contact_name",
      "emergency_contact_relationship",
      "emergency_contact_address",
      "emergency_contact_number",
    ]);
  });
});

describe("validateEmergencyContactUpdate (Edit dialogs)", () => {
  const blank = normalizeEmergencyContact({});

  it("lets an account with none on file stay blank", () => {
    expect(validateEmergencyContactUpdate(blank, OWN_NUMBER, false)).toBeNull();
  });

  it("refuses to remove one that is on file", () => {
    expect(validateEmergencyContactUpdate(blank, OWN_NUMBER, true)).toMatch(/cannot be removed/);
  });

  it("checks every field once any is filled", () => {
    const partial = normalizeEmergencyContact({ emergency_contact_name: "Maria Dela Cruz" });
    expect(validateEmergencyContactUpdate(partial, OWN_NUMBER, false)).toMatch(/relationship/);
    expect(validateEmergencyContactUpdate(contact(), OWN_NUMBER, true)).toBeNull();
  });
});

describe("the Edit dialogs and Profile pages carry it", () => {
  it.each([
    "src/app/api/hr/employees/route.js",
    "src/app/api/admin/users/route.js",
  ])("%s validates edits and stores them", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("validateEmergencyContactUpdate(");
    expect(source).toContain("emergencyContactColumns(emergencyContact)");
    expect(source).toMatch(/emergency_contact_name,emergency_contact_relationship/);
  });

  it("employee Profile page shows the card", () => {
    const page = readFileSync("src/app/employee/profile-page.jsx", "utf8");
    ["name", "relationship", "number", "address"].forEach((field) => {
      expect(page).toContain(`emergency_contact_${field}`);
    });
  });

  it.each([
    ["accountant", "ac-profile"],
    ["admin", "adm-profile"],
    ["hr", "hr-profile"],
    ["super-admin", "sa-profile"],
  ])("%s Profile page shows the card", (portal, pageId) => {
    // The four staff portals share one Profile page.
    const shell = readFileSync(`src/app/${portal}/${portal}-portal.jsx`, "utf8");
    expect(shell).toContain(`current === "${pageId}" ? <StaffProfilePage`);
    const profile = readFileSync("src/components/portal/staff-profile.jsx", "utf8");
    ["name", "relationship", "number", "address"].forEach((field) => {
      expect(profile).toContain(`ctx?.emergency_contact_${field}`);
    });
  });
});

describe("every account-creation path collects it", () => {
  const routes = [
    "src/app/api/admin/employees/route.js",
    "src/app/api/admin/staff-accounts/route.js",
  ];

  it.each(routes)("%s validates before creating the auth user and stores the columns", (path) => {
    const source = readFileSync(path, "utf8");
    const validateAt = source.indexOf("validateEmergencyContact(");
    const createAt = source.indexOf("auth.admin.createUser(");
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(createAt);
    expect(source).toContain("...emergencyContactColumns(emergencyContact)");
  });

  it.each([
    "src/app/hr/employee-form-dialog.jsx",
    "src/app/super-admin/staff-account-dialogs.jsx",
  ])("%s has the fields", (path) => {
    const source = readFileSync(path, "utf8");
    ["emergency_contact_name", "emergency_contact_relationship", "emergency_contact_address", "emergency_contact_number"]
      .forEach((name) => {
        expect(source).toContain(`"${name}"`);
      });
  });
});
