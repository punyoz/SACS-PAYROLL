import { describe, it, expect } from "vitest";
import { formatStaffId, generateUniqueStaffId, isStaffIdRole } from "@/lib/employees/staff-id";

describe("staff ID", () => {
  it("starts at STAFF-001", () => {
    expect(generateUniqueStaffId([])).toBe("STAFF-001");
  });

  it("follows the highest ID already issued", () => {
    expect(generateUniqueStaffId(["STAFF-001", "staff-007", "STAFF-003"])).toBe("STAFF-008");
  });

  it("ignores values that are not staff IDs", () => {
    expect(generateUniqueStaffId(["SACS-050", "", null])).toBe("STAFF-001");
  });

  it("keeps growing past three digits", () => {
    expect(formatStaffId(1000)).toBe("STAFF-1000");
    expect(generateUniqueStaffId(["STAFF-999"])).toBe("STAFF-1000");
  });

  it("applies to Super Admin, Admin and HR only", () => {
    expect(["super_admin", "admin", "hr"].every(isStaffIdRole)).toBe(true);
    expect(isStaffIdRole("employee")).toBe(false);
    expect(isStaffIdRole("accountant")).toBe(false);
  });
});
