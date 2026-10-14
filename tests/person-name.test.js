/**
 * The one rule for a person's name (src/lib/person-name.js): letters (ñ and
 * accents too), spaces, hyphens, apostrophes and periods -- never digits --
 * on every account form and in every route that stores a name.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table, users } from "./helpers/fake-supabase.js";
import { cleanNameInput, isPersonName, PERSON_NAME_PATTERN } from "@/lib/person-name";
import { NAME_PART_PATTERN, validateNameParts } from "@/lib/employees/staff-record";
import { validateEmergencyContact } from "@/lib/employees/emergency-contact";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

describe("the rule", () => {
  it.each(["Juan", "Ma. Niña", "Dela Peña", "O'Brien", "Ibáñez", "Santos-Reyes", "Jr."])("accepts %s", (name) => {
    expect(isPersonName(name)).toBe(true);
  });

  it.each(["Default53151512512", "4124214124", "Juan2", "Ana_Cruz", "Maria@", "-Ana", ""])("refuses %j", (name) => {
    expect(isPersonName(name)).toBe(false);
  });

  it("is the same rule the staff and emergency-contact checks use", () => {
    expect(NAME_PART_PATTERN).toBe(PERSON_NAME_PATTERN);
    expect(validateNameParts({ first_name: "Juan2", last_name: "Cruz" })).toMatch(/First name may contain letters/);
  });

  it("drops digits and symbols as they are typed, and says so", () => {
    expect(cleanNameInput("Default53151512512")).toEqual({ value: "Default", removed: true });
    expect(cleanNameInput("Dela Peña")).toEqual({ value: "Dela Peña", removed: false });
    expect(cleanNameInput("Ana#1 Cruz")).toEqual({ value: "Ana Cruz", removed: true });
  });
});

describe("POST /api/legacy-auth/update-profile (Edit Account)", () => {
  const ME = "11111111-1111-4111-8111-111111111111";
  let POST;
  let createSessionToken;
  let SESSION_COOKIE;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-person-name";
    resetDb();
    users.push({ id: ME, email: "ana@sacs.test", user_metadata: { role: "employee", full_name: "Ana Cruz" } });
    table("profiles").push({ id: ME, full_name: "Ana Cruz", first_name: "Ana", last_name: "Cruz", role: "employee", branch_id: "b1", cp_number: "09171234567" });
    ({ POST } = await import("@/app/api/legacy-auth/update-profile/route"));
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  const save = (body) => POST(new Request("https://sacs.test/api/legacy-auth/update-profile", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${createSessionToken({ user_id: ME, role: "employee", branch_id: "b1", email: "ana@sacs.test", full_name: "Ana Cruz", session_id: "s" })}`,
    },
    body: JSON.stringify(body),
  }));

  it("refuses digits in the name parts", async () => {
    const response = await save({ first_name: "Default53151512512", middle_name: "4124214124", last_name: "Employee421412421" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/First name may contain letters, spaces, hyphens, apostrophes and periods only/);
    expect(table("profiles")[0].full_name).toBe("Ana Cruz");
  });

  it("refuses digits in a full name sent on its own (the old caller's path)", async () => {
    const response = await save({ full_name: "Ana Cruz 2" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Full name may contain letters/);
    expect(table("profiles")[0].full_name).toBe("Ana Cruz");
  });

  it("refuses digits in the emergency contact person", async () => {
    expect(validateEmergencyContact({
      emergency_contact_name: "Maria 2", emergency_contact_relationship: "Parent",
      emergency_contact_number: "09181234567", emergency_contact_address: "123 Rizal St., Antipolo",
    }, "09171234567")).toMatch(/Emergency contact name may contain letters/);
  });

  it("saves a real name with ñ, a period and an apostrophe", async () => {
    const response = await save({ first_name: "Ma. Niña", middle_name: "", last_name: "Dela Peña-O'Brien" });
    expect(response.status).toBe(200);
    expect(table("profiles")[0]).toMatchObject({ first_name: "Ma. Niña", last_name: "Dela Peña-O'Brien" });
  });
});
