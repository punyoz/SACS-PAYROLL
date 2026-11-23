// Part I (2026-11-23): one sidebar item per module, tabs inside the page.
import { describe, it, expect } from "vitest";
import { allowedTabs, holdsPage, itemBadge, itemOfPage, navPages } from "@/lib/portal/nav-tabs";

const nav = [
  { section: "A", items: [{ id: "x-dash", label: "Dashboard", module: "dashboard" }] },
  { section: "B", items: [{ id: "x-loans", label: "Loans & Subsidies", tabs: [
    { id: "x-loans", label: "Loans", module: "loans" }, { id: "x-subs", label: "Subsidies", module: "subsidy" }] }] },
];

describe("module tabs", () => {
  it("every page once, each tab keeps its own id and permission", () => {
    expect(navPages(nav).map((p) => [p.id, p.module])).toEqual([["x-dash", "dashboard"], ["x-loans", "loans"], ["x-subs", "subsidy"]]);
  });
  it("an old page id opens its module; the item is active on any of its tabs", () => {
    expect(itemOfPage(nav, "x-subs").label).toBe("Loans & Subsidies");
    expect(holdsPage(nav[1].items[0], "x-subs")).toBe(true);
    expect(itemOfPage(nav, "nope")).toBeNull();
  });
  it("permissions unchanged: only allowed tabs; badges summed over them", () => {
    const can = (m) => m !== "subsidy";
    expect(allowedTabs(nav[1].items[0], can).map((t) => t.id)).toEqual(["x-loans"]);
    expect(itemBadge(nav[1].items[0], { "x-loans": 2, "x-subs": 3 })).toBe(5);
    expect(itemBadge(nav[1].items[0], { "x-loans": 2, "x-subs": 3 }, can)).toBe(2);
  });
});
