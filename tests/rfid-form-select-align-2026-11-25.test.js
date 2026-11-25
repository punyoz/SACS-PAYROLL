import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("2026-11-25: the Admin's RFID report form and dropdown alignment", () => {
  it("the report form offers only what the Admin cannot fix, and points to Lost / Replace", () => {
    const page = src("src/app/admin/requests-pages.jsx");
    expect(page).toMatch(/ADMIN_RFID_ISSUE_TYPES = Object\.freeze\(\{ reader_fault: RFID_ISSUE_TYPES\.reader_fault, other: RFID_ISSUE_TYPES\.other \}\)/);
    expect(page).toMatch(/options: ADMIN_RFID_ISSUE_TYPES/);
    expect(page).toMatch(/initial=\{\{ issue_type: "reader_fault" \}\}/);
    expect(page).toMatch(/use Lost or Replace on the card in RFID cards above/);
  });
  it("older reports keep their labels", async () => {
    const { RFID_ISSUE_TYPES } = await import("@/lib/branch-requests");
    expect(RFID_ISSUE_TYPES.lost_card).toBe("Lost card");
    expect(RFID_ISSUE_TYPES.broken_card).toBe("Broken card");
  });
  it("a dropdown takes no space-y gap for its hidden native select", () => {
    expect(src("src/components/ui/select.jsx")).toContain("[&:has(+select[aria-hidden=true]:last-child)]:mb-0");
  });
});
