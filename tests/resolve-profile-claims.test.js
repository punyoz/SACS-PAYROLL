import { describe, it, expect } from "vitest";
import { buildProfilePayload } from "@/lib/auth/resolve-profile-claims";

/**
 * resolveLoginProfile() itself talks to Supabase and is exercised indirectly
 * through the two login routes; buildProfilePayload() is the pure part of
 * this module (shaping already-resolved fields into the response body), and
 * is fully testable in isolation. Moved verbatim out of
 * src/app/api/legacy-auth/login/route.js — these assertions describe the
 * pre-existing, unchanged behaviour, not new behaviour.
 */

const RESOLVED = {
  profileRow: {
    cp_number: "0917-000-0000",
    date_hired: "2020-01-01",
    address: "Cebu City",
    sss_number: "01-2345678-9",
    pagibig_number: "1234-5678-9012",
    philhealth_number: "12-345678901-2",
    bank_name: "BDO",
    bank_account_number: "001234567890",
  },
  metadata: {
    tin_number: "123-456-789",
    sex: "female",
    civil_status: "single",
    employment_type: "Full-time",
    employment_status: "Active",
    date_of_birth: "1998-05-12",
  },
  resolvedRole: "hr",
  resolvedFullName: "Jane Dela Cruz",
  resolvedEmailOutput: "jane@school.edu",
  resolvedEmployeeId: "SACS-014",
  resolvedEmployeeType: "Non-Teaching",
  resolvedPosition: "Employee",
  resolvedBranchId: "branch-1",
};

describe("buildProfilePayload", () => {
  it("prefers the profiles table over metadata for the fields profiles owns", () => {
    const payload = buildProfilePayload(RESOLVED, false);
    expect(payload.bank_account_number).toBe("001234567890");
    expect(payload.sss_number).toBe("01-2345678-9");
  });

  it("falls back to metadata-only fields for what profiles does not carry", () => {
    const payload = buildProfilePayload(RESOLVED, false);
    expect(payload.tin_number).toBe("123-456-789");
    expect(payload.sex).toBe("female");
  });

  it("falls back to an empty string, not undefined, when a field is missing everywhere", () => {
    const sparse = { ...RESOLVED, profileRow: null, metadata: {} };
    const payload = buildProfilePayload(sparse, false);
    expect(payload.bank_account_number).toBe("");
    expect(payload.tin_number).toBe("");
  });

  it("carries must_change_password through as a plain boolean", () => {
    expect(buildProfilePayload(RESOLVED, true).must_change_password).toBe(true);
    expect(buildProfilePayload(RESOLVED, false).must_change_password).toBe(false);
    expect(buildProfilePayload(RESOLVED, undefined).must_change_password).toBe(false);
  });

  it("includes role, branch and identity fields from the resolved shape", () => {
    const payload = buildProfilePayload(RESOLVED, false);
    expect(payload.role).toBe("hr");
    expect(payload.branch_id).toBe("branch-1");
    expect(payload.employee_id).toBe("SACS-014");
    expect(payload.full_name).toBe("Jane Dela Cruz");
  });
});
