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

  it.each([
    ["employee", "ep-ec"],
    ["accountant", "ac-ep-ec"],
    ["admin", "adm-ep-ec"],
    ["hr", "hr-ep-ec"],
    ["super-admin", "sa-ep-ec"],
  ])("%s Profile page shows the card", (page, prefix) => {
    const html = readFileSync(`public/legacy/pages/${page}.html`, "utf8");
    const js = readFileSync(`public/legacy/js/${page}.js`, "utf8");
    ["name", "relationship", "number", "address"].forEach((field) => {
      expect(html).toContain(`id="${prefix}-${field}"`);
    });
    expect(js).toContain(`loadOwnEmergencyContact('${prefix}')`);
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
    ["public/legacy/pages/hr.html", "public/legacy/js/hr.js"],
    ["public/legacy/pages/super-admin.html", "public/legacy/js/super-admin.js"],
  ])("%s has the fields and its script sends them", (page, script) => {
    const html = readFileSync(page, "utf8");
    const js = readFileSync(script, "utf8");
    ["emergency_contact_name", "emergency_contact_relationship", "emergency_contact_address", "emergency_contact_number"]
      .forEach((name) => {
        expect(html).toContain(`name="${name}"`);
        expect(js).toContain(`${name}`);
      });
  });
});
