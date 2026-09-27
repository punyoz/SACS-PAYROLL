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
    // Only the last four digits are selected; the full numbers are encrypted
    // (src/lib/employees/pii.js).
    sss_number_last4: "6789",
    pagibig_number_last4: "9012",
    philhealth_number_last4: "9012",
    tin_number_last4: "6789",
    bank_name: "BDO",
    bank_account_number_last4: "7890",
  },
  metadata: {
    // A leftover copy in metadata must never reach the payload.
    sss_number: "0123456789",
    tin_number: "123456789",
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
  it("masks government IDs and the bank account number to their last four digits", () => {
    const payload = buildProfilePayload(RESOLVED, false);
    expect(payload.bank_account_number).toBe("••••7890");
    expect(payload.sss_number).toBe("••••6789");
    expect(payload.pagibig_number).toBe("••••9012");
    expect(payload.philhealth_number).toBe("••••9012");
    expect(payload.tin_number).toBe("••••6789");
    expect(payload.bank_name).toBe("BDO");
  });

  it("never carries a full number from metadata, and falls back to it for other fields", () => {
    const payload = buildProfilePayload(RESOLVED, false);
    expect(JSON.stringify(payload)).not.toContain("0123456789");
    expect(JSON.stringify(payload)).not.toContain("123456789");
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
