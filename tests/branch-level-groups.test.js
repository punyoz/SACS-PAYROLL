/**
 * Work Schedules → Employees and their schedules, grouped by branch and then
 * by level, with a select-all box on each heading
 * (src/components/portal/branch-level-groups.jsx).
 */

import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BranchLevelGroups } from "@/components/portal/branch-level-groups";

const LEVELS = [
  { value: "preschool", label: "Pre-school" },
  { value: "grade_school", label: "Grade School" },
  { value: "non_teaching", label: "Non-teaching" },
];
const rows = [
  { id: "1", full_name: "Ana", branch_id: "b1", branch_name: "Main Branch", employee_level: "grade_school" },
  { id: "2", full_name: "Ben", branch_id: "b1", branch_name: "Main Branch", employee_level: "preschool" },
  { id: "3", full_name: "Cara", branch_id: "b1", branch_name: "Main Branch", employee_level: "preschool" },
  { id: "4", full_name: "Dan", branch_id: "b1", branch_name: "Main Branch", employee_level: null },
  { id: "5", full_name: "Eve", branch_id: "b2", branch_name: "Antipolo Branch", employee_level: "non_teaching" },
];
const columns = [
  { key: "pick", header: "Select", cell: (r) => `[${r.id}]` },
  { key: "full_name", header: "Employee", cell: (r) => r.full_name },
];

function render(selected = new Set(), selectable = true) {
  return renderToStaticMarkup(React.createElement(BranchLevelGroups, {
    columns,
    rows,
    groupOf: (r) => r.branch_id,
    groupLabel: (r) => r.branch_name,
    subgroupOf: (r) => r.employee_level || "none",
    subgroupLabel: (key) => LEVELS.find((l) => l.value === key)?.label || "Level not set",
    subgroupOrder: LEVELS.map((l) => l.value),
    selectable,
    selected,
    onSelectedChange: () => {},
  }));
}

const order = (html, labels) => labels.map((label) => html.indexOf(label));

describe("Employees grouped by branch, then level", () => {
  it("branches alphabetically; inside each, levels in school order with 'not set' last; names alphabetical", () => {
    const html = render();
    const pos = order(html, ["Antipolo Branch", "Eve", "Main Branch", "Pre-school", "Ben", "Cara", "Grade School", "Ana", "Level not set", "Dan"]);
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("each heading counts its employees", () => {
    const html = render();
    expect(html).toContain("Main Branch</span><span class=\"ml-2 text-xs text-muted-foreground\">4 employees");
    expect(html).toContain("Pre-school</span><span class=\"ml-2 text-xs text-muted-foreground\">2 employees");
    expect(html).toContain("Antipolo Branch</span><span class=\"ml-2 text-xs text-muted-foreground\">1 employee<");
  });

  it("a select-all box on every branch and every level", () => {
    const html = render();
    expect(html).toContain('aria-label="Select all 4 in Main Branch"');
    expect(html).toContain('aria-label="Select all 2 in Main Branch, Pre-school"');
    expect(html).toContain('aria-label="Select all 1 in Antipolo Branch, Non-teaching"');
  });

  it("a level is ticked when all of it is selected; its branch shows the partial count", () => {
    const html = render(new Set(["2", "3"]));
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Select all 2 in Main Branch, Pre-school"/);
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Select all 4 in Main Branch"/);
    expect(html).toContain("2 of 4 selected");
  });

  it("read-only (Admin): no boxes", () => {
    expect(render(new Set(), false)).not.toContain("Select all");
  });
});
