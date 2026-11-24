import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { branchOptions, isArchivedBranch } from "@/lib/branches/archived";

const list = [{ id: "a", name: "Main Branch", status: "Active" }, { id: "b", name: "Angono", status: "Archived" }, { id: "c", name: "Old", status: "Closed" }, { id: "d", name: "Robinson", status: "Inactive" }];

describe("archived branches (2026-11-24)", () => {
  it("Archived (and the older Closed) are archived; Active / Inactive are not", () => {
    expect(list.map(isArchivedBranch)).toEqual([false, true, true, false]);
  });
  it("dropdowns offer the active ones; Show archived adds the rest; a chosen archived branch stays", () => {
    expect(branchOptions(list).map((b) => b.id)).toEqual(["a", "d"]);
    expect(branchOptions(list, { showArchived: true }).map((b) => b.id)).toEqual(["a", "b", "c", "d"]);
    expect(branchOptions(list, { selected: "b" }).map((b) => b.id)).toEqual(["a", "b", "d"]);
  });
  it("the branch list hides archived branches unless asked; archiving waits until nobody active is left", () => {
    const route = readFileSync("src/app/api/admin/branches/route.js", "utf8");
    expect(route).toMatch(/include_archived/);
    expect(route).toMatch(/still has \$\{count\} active account/);
  });
});
