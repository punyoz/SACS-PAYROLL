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
  { id: "6", full_name: "Fay", branch_id: null, branch_name: null, employee_level: null },
];
const columns = [
  { key: "full_name", header: "Employee", cell: (r) => r.full_name },
];

function render(selected = new Set(), selectable = true) {
  return renderToStaticMarkup(React.createElement(BranchLevelGroups, {
    columns,
    rows,
    groupOf: (r) => r.branch_id || "none",
    groupLabel: (r) => r.branch_name || "No branch",
    subgroupOf: (r) => r.employee_level || "none",
    subgroupLabel: (key) => LEVELS.find((l) => l.value === key)?.label || "Level not set",
    subgroupOrder: LEVELS.map((l) => l.value),
    summary: (list) => `${list.length} employee${list.length === 1 ? "" : "s"}`,
    selectable,
    selected,
    onSelectedChange: () => {},
  }));
}

const order = (html, labels) => labels.map((label) => html.indexOf(label));

describe("Employees grouped by branch (collapsed), then level", () => {
  it("every branch starts collapsed: headings only, no employee rows", () => {
    const html = render();
    expect(html.match(/data-testid="ws-branch"/g)).toHaveLength(3);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(html).not.toContain("data-testid=\"ws-row\"");
    expect(html).not.toContain(">Ana<");
  });

  it("branches alphabetically, 'No branch' last", () => {
    const pos = order(render(), ['data-branch="Antipolo Branch"', 'data-branch="Main Branch"', 'data-branch="No branch"']);
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("each heading carries its summary", () => {
    const html = render();
    expect(html).toContain("Main Branch</span><span class=\"text-xs text-muted-foreground\"> · 4 employees");
    expect(html).toContain("Antipolo Branch</span><span class=\"text-xs text-muted-foreground\"> · 1 employee<");
  });

  it("a branch box: ticked when all are selected, partial when some, clear when none", () => {
    expect(render(new Set(["1", "2", "3", "4"]))).toMatch(/aria-checked="true"[^>]*aria-label="Select all in Main Branch"/);
    expect(render(new Set(["2"]))).toMatch(/aria-checked="mixed"[^>]*aria-label="Select all in Main Branch"/);
    expect(render(new Set(["2"]))).toMatch(/aria-checked="false"[^>]*aria-label="Select all in Antipolo Branch"/);
  });

  it("read-only (Admin): no boxes", () => {
    expect(render(new Set(), false)).not.toContain("Select all");
  });
});
