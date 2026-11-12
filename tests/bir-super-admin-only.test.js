/**
 * The BIR is the Super Admin's only (decision 2026-11-12), and the Super
 * Admin's BIR boxes follow the system's shared input rules.
 *
 *   - No other role has the bir_forms module; the My Account group has six
 *     items (no "My BIR Form 2316"); the old page ids are retired (Not found).
 *   - BIR employer details: numbers-only boxes drop letters and symbols as
 *     typed and pasted, name boxes drop digits, every box has a maximum, and
 *     the config API refuses the same bad values on a direct call.
 * Fake data only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, table } from "./helpers/fake-supabase.js";
import { can, ROLE_PERMISSIONS } from "@/lib/rbac/permissions";
import { MY_DESCRIPTIONS, MY_PAGE_IDS, myAccountGroup } from "@/components/portal/my-account";
import { NOT_FOUND_PAGE, RETIRED_PAGE_IDS } from "@/components/portal/session";
import {
  BIR_EMPLOYER_FIELDS, birEmployerErrors, birEmployerStoredValue, cleanBirEmployerInput, DIGITS_TYPING_HINT,
} from "@/lib/payroll/bir-employer";
import { NAME_TYPING_HINT } from "@/lib/person-name";

vi.mock("@supabase/supabase-js", async () => (await import("./helpers/fake-supabase.js")).supabaseModule);

const SIX = ["My Attendance", "My Timesheet", "My Leave", "My Payslips", "My Requests", "My Profile"];

describe("BIR access: the Super Admin only", () => {
  it("only the Super Admin holds bir_forms", () => {
    for (const action of ["create", "read", "update"]) expect(can("super_admin", "bir_forms", action), action).toBe(true);
    for (const role of ["admin", "hr", "accountant", "employee"]) {
      for (const action of ["create", "read", "update", "delete"]) expect(can(role, "bir_forms", action), `${role} ${action}`).toBe(false);
    }
    expect(can("super_admin", "bir_forms", "delete")).toBe(false);
    // Payroll Reports stays the Accountant's (without the BIR cards).
    expect(ROLE_PERMISSIONS.accountant.payroll_reports.actions).toContain("read");
  });

  it("My Account has six items for the Employee, HR and the Accountant, with no BIR item", () => {
    for (const prefix of ["emp", "hr", "ac"]) {
      const group = myAccountGroup(prefix);
      expect(group.items.map((i) => i.label), prefix).toEqual(SIX);
      expect(group.items.every((i) => i.id && i.label && i.icon), prefix).toBe(true);
      expect(Object.keys(MY_PAGE_IDS[prefix])).not.toContain("bir");
      expect(JSON.stringify(group.items.map((i) => [i.id, i.label]))).not.toMatch(/BIR|2316|alphalist/i);
    }
    expect(Object.keys(MY_DESCRIPTIONS)).not.toContain("bir");
  });

  it("the old BIR page ids are retired and show Not found", () => {
    expect(RETIRED_PAGE_IDS).toEqual(["emp-bir", "hr-my-bir", "ac-my-bir"]);
    expect(NOT_FOUND_PAGE).toBe("page-not-found");
    for (const prefix of ["emp", "hr", "ac"]) {
      expect(Object.values(MY_PAGE_IDS[prefix]).some((id) => RETIRED_PAGE_IDS.includes(id))).toBe(false);
    }
  });
});

describe("BIR employer details: typing and pasting", () => {
  it("numbers-only boxes keep digits only (TIN in the employee format, RDO 3, ZIP 4)", () => {
    expect(cleanBirEmployerInput("bir_employer_tin", "12a3-45b6")).toEqual({ value: "123-456", hint: DIGITS_TYPING_HINT });
    expect(cleanBirEmployerInput("bir_employer_tin", "123456789000001234").value).toBe("123-456-789-00000");
    expect(cleanBirEmployerInput("bir_employer_tin", "123-456-789").hint).toBe("");
    expect(cleanBirEmployerInput("bir_rdo_code", "0a4b6c9")).toEqual({ value: "046", hint: DIGITS_TYPING_HINT });
    expect(cleanBirEmployerInput("bir_zip_code", "ZIP 1870-99")).toEqual({ value: "1870", hint: DIGITS_TYPING_HINT });
    expect(cleanBirEmployerInput("bir_zip_code", "1870")).toEqual({ value: "1870", hint: "" });
  });

  it("name boxes drop digits and symbols as typed or pasted (the shared person-name rule)", () => {
    expect(cleanBirEmployerInput("bir_signatory_name", "Ma. Theresa Dela Cruz-O'Brien")).toEqual({ value: "Ma. Theresa Dela Cruz-O'Brien", hint: "" });
    expect(cleanBirEmployerInput("bir_signatory_name", "Juan2 Dela Cruz#")).toEqual({ value: "Juan Dela Cruz", hint: NAME_TYPING_HINT });
    expect(cleanBirEmployerInput("bir_employer_name", "SACS 2026 Inc.").value).toBe("SACS  Inc.");
    expect(cleanBirEmployerInput("bir_signatory_title", "School Director <b>").value).toBe("School Director b");
    expect(cleanBirEmployerInput("bir_signatory_title", "Director (Grade 1-6)").hint).toBe("");
  });

  it("every box has a maximum length", () => {
    for (const [key, , , maxLength] of BIR_EMPLOYER_FIELDS) {
      expect(maxLength, key).toBeGreaterThan(0);
      const long = key.includes("tin") || key.includes("code") ? "9".repeat(400) : "a".repeat(400);
      expect(cleanBirEmployerInput(key, long).value.length, key).toBeLessThanOrEqual(maxLength);
    }
  });

  it("stores the TIN as digits only, as the employees' TINs", () => {
    expect(birEmployerStoredValue("bir_employer_tin", "123-456-789-00000")).toBe("12345678900000");
    expect(birEmployerStoredValue("bir_signatory_name", "  Ana   Reyes ")).toBe("Ana Reyes");
  });
});

describe("BIR employer details: the rules the server enforces", () => {
  it("refuses letters in number fields and digits in names, with clear messages", () => {
    const errors = birEmployerErrors({
      bir_employer_tin: "123456789x", bir_rdo_code: "04a", bir_zip_code: "18 70", bir_signatory_name: "Ana 2",
      bir_employer_name: "SACS #1", bir_signatory_title: "Director <script>", bir_registered_address: "x".repeat(251),
    });
    expect(errors).toEqual({
      bir_employer_tin: "Employer TIN: numbers only (dashes and spaces are fine).",
      bir_rdo_code: "The RDO code is 3 digits (numbers only).",
      bir_zip_code: "The ZIP code is 4 digits (numbers only).",
      bir_signatory_name: "Authorized signatory may contain letters, spaces, hyphens, apostrophes and periods only.",
      bir_employer_name: "Registered name may contain letters, spaces, hyphens, apostrophes and periods only.",
      bir_signatory_title: "Signatory's title: letters, numbers, spaces and . , ' ( ) / & - only.",
      bir_registered_address: "Registered address can be at most 250 characters.",
    });
    // The system's TIN lengths: 9, 12 or 14 digits.
    expect(birEmployerErrors({ bir_employer_tin: "1234567890" }).bir_employer_tin).toBe("TIN must be 9, 12 or 14 digits (with the branch code).");
    for (const ok of ["123456789", "123-456-789-000", "123-456-789-00000"]) expect(birEmployerErrors({ bir_employer_tin: ok }), ok).toEqual({});
    // Blank stays allowed; an object is not text.
    expect(birEmployerErrors({ bir_rdo_code: "", bir_zip_code: "  " })).toEqual({});
    expect(birEmployerErrors({ bir_zip_code: { a: 1 } }).bir_zip_code).toMatch(/enter text/);
    expect(birEmployerErrors({ bir_registered_address: "Lot 4, Blk 2, Brgy. San Isidro, Antipolo City, Rizal" })).toEqual({});
  });
});

describe("PATCH /api/admin/config with BIR employer details (direct API call)", () => {
  let createSessionToken;
  let SESSION_COOKIE;
  const SA = { user_id: "u-sa", role: "super_admin", branch_id: null, full_name: "Sam Super", email: "u-sa@sacs.test", session_id: "s-1" };
  const patch = async (fields, section = "general") => {
    const { PATCH } = await import("@/app/api/admin/config/route");
    const token = createSessionToken(SA);
    return PATCH(new Request("https://sacs.test/api/admin/config", {
      method: "PATCH", headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, body: JSON.stringify({ section, fields }),
    }));
  };

  beforeEach(async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SESSION_SECRET = "test-secret-bir-config";
    resetDb();
    ({ createSessionToken, SESSION_COOKIE } = await import("@/lib/rbac/session"));
  });

  it("rejects letters in the TIN, RDO and ZIP, digits in a name, and an over-long box; nothing is saved", async () => {
    for (const [fields, field, message] of [
      [{ bir_employer_tin: "12345678A" }, "bir_employer_tin", /numbers only/],
      [{ bir_rdo_code: "4b6" }, "bir_rdo_code", /3 digits/],
      [{ bir_zip_code: "187O" }, "bir_zip_code", /4 digits/],
      [{ bir_signatory_name: "R2-D2" }, "bir_signatory_name", /letters, spaces/],
      [{ bir_employer_name: "a".repeat(201) }, "bir_employer_name", /at most 200/],
    ]) {
      const response = await patch(fields);
      expect(response.status, field).toBe(400);
      const body = await response.json();
      expect(body.field, field).toBe(field);
      expect(body.error, field).toMatch(message);
    }
    expect(table("system_config")).toEqual([]);
    // Only the General section holds them.
    expect((await patch({ bir_zip_code: "1870" }, "payroll")).status).toBe(400);
  });

  it("saves good values, the TIN as digits only", async () => {
    const response = await patch({
      bir_employer_name: "Shepherd Angels Christian School Inc.", bir_employer_tin: "123-456-789-00000", bir_rdo_code: "046",
      bir_zip_code: "1870", bir_signatory_name: "Ma. Ana Reyes", bir_signatory_title: "School Director", bir_registered_address: "Antipolo City, Rizal",
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const saved = Object.fromEntries(table("system_config").map((r) => [r.key, r.value]));
    expect(saved).toMatchObject({ bir_employer_tin: "12345678900000", bir_rdo_code: "046", bir_zip_code: "1870", bir_signatory_name: "Ma. Ana Reyes" });
  });
});
