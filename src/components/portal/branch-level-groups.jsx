"use client";

import * as React from "react";
import { SearchIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/portal/empty-state";
import { cn } from "@/lib/utils";
import { SEARCH_MAX } from "@/lib/input-limits";

/**
 * Rows grouped by branch, then by level inside each branch, with a
 * "select all" box on every branch and every level heading (Work Schedules:
 * pick a whole branch, or one level of one branch, in a click). The heading
 * rows use the same look as BranchGroupedTable. A heading's box is ticked
 * when every visible row under it is selected; a partial selection is
 * spelled out next to it ("2 of 5 selected").
 *
 * columns: [{ key, header, cell(row), className?, align? }] -- the first
 * column is the selection box when `selectable` (its own cell is used).
 * groupOf(row) / groupLabel(row): the branch. subgroupOf(row) /
 * subgroupLabel(key): the level; subgroupOrder: level keys in display order
 * (rows whose level is not in it come last).
 */
export function BranchLevelGroups({
  columns,
  rows,
  groupOf,
  groupLabel,
  subgroupOf,
  subgroupLabel,
  subgroupOrder = [],
  selectable = false,
  selected,
  onSelectedChange,
  search,
  searchPlaceholder = "Search…",
  loading = false,
  empty = "No employees",
  unit = "employee",
  caption,
  minWidth = 760,
}) {
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && search ? rows.filter((row) => String(search(row) || "").toLowerCase().includes(q)) : rows;
  }, [rows, query, search]);

  // Branch -> level -> rows, branches and names alphabetical, levels in order.
  const groups = React.useMemo(() => {
    const rank = (key) => {
      const i = subgroupOrder.indexOf(key);
      return i === -1 ? subgroupOrder.length : i;
    };
    const byGroup = new Map();
    filtered.forEach((row) => {
      const g = groupOf(row);
      if (!byGroup.has(g)) byGroup.set(g, { key: g, label: groupLabel(row), rows: [] });
      byGroup.get(g).rows.push(row);
    });
    return [...byGroup.values()]
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      .map((group) => {
        const bySub = new Map();
        group.rows.forEach((row) => {
          const s = subgroupOf(row);
          if (!bySub.has(s)) bySub.set(s, []);
          bySub.get(s).push(row);
        });
        const subgroups = [...bySub.entries()]
          .sort(([a], [b]) => rank(a) - rank(b))
          .map(([key, list]) => ({
            key,
            label: subgroupLabel(key),
            rows: list.sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""))),
          }));
        return { ...group, subgroups };
      });
  }, [filtered, groupOf, groupLabel, subgroupOf, subgroupLabel, subgroupOrder]);

  const ids = (list) => list.map((row) => row.id);
  const selectedIn = (list) => list.filter((row) => selected?.has(row.id)).length;
  const toggle = (list) => {
    const all = list.length > 0 && selectedIn(list) === list.length;
    const next = new Set(selected);
    ids(list).forEach((id) => (all ? next.delete(id) : next.add(id)));
    onSelectedChange(next);
  };

  const headingBox = (list, label) => {
    const n = selectedIn(list);
    return (
      <Checkbox
        checked={list.length > 0 && n === list.length}
        onCheckedChange={() => toggle(list)}
        aria-label={`Select all ${list.length} in ${label}`}
      />
    );
  };
  const partial = (list) => {
    const n = selectedIn(list);
    return n > 0 && n < list.length ? <span className="ml-2 text-xs font-medium text-primary">{n} of {list.length} selected</span> : null;
  };
  const count = (n) => <span className="ml-2 text-xs text-muted-foreground">{n} {unit}{n === 1 ? "" : "s"}</span>;
  const rest = selectable ? columns.length - 1 : columns.length;

  const body = [];
  groups.forEach((group) => {
    const groupRows = group.subgroups.flatMap((s) => s.rows);
    body.push(
      <TableRow key={`g-${group.key}`} className="bg-primary/8 hover:bg-primary/8">
        {selectable ? <TableCell className="w-10 py-2">{headingBox(groupRows, group.label)}</TableCell> : null}
        <TableCell colSpan={rest} className="py-2">
          <span className="font-semibold text-primary">{group.label}</span>
          {count(groupRows.length)}
          {selectable ? partial(groupRows) : null}
        </TableCell>
      </TableRow>,
    );
    group.subgroups.forEach((sub) => {
      body.push(
        <TableRow key={`s-${group.key}-${sub.key}`} className="bg-muted/40 hover:bg-muted/40">
          {selectable ? <TableCell className="w-10 py-1.5 pl-5">{headingBox(sub.rows, `${group.label}, ${sub.label}`)}</TableCell> : null}
          <TableCell colSpan={rest} className={cn("py-1.5", !selectable && "pl-5")}>
            <span className="text-sm font-medium">{sub.label}</span>
            {count(sub.rows.length)}
            {selectable ? partial(sub.rows) : null}
          </TableCell>
        </TableRow>,
      );
      sub.rows.forEach((row) => {
        body.push(
          <TableRow key={row.id} data-state={selected?.has(row.id) ? "selected" : undefined}>
            {columns.map((column, index) => (
              <TableCell key={column.key} className={cn(selectable && index === 0 && "w-10 pl-5", column.align === "right" && "text-right", column.className)}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>,
        );
      });
    });
  });

  return (
    <div className="flex flex-col gap-3">
      {search ? (
        <div className="relative sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input maxLength={SEARCH_MAX} type="search" className="pl-8" placeholder={searchPlaceholder} aria-label={searchPlaceholder.replace(/…$/, "")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table style={{ minWidth }}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader className="bg-muted/60">
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead key={column.key} className={cn("h-10 text-xs font-semibold text-muted-foreground", column.align === "right" && "text-right")}>{column.header}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? Array.from({ length: 5 }, (_, i) => (
              <TableRow key={i}>{columns.map((column) => <TableCell key={column.key}><Skeleton className="h-4 w-3/4" /></TableCell>)}</TableRow>
            )) : !filtered.length ? (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={columns.length} className="p-0 whitespace-normal"><EmptyState title={query ? "No employees match your search." : empty} /></TableCell></TableRow>
            ) : body}
          </TableBody>
        </Table>
      </div>
      {!loading && filtered.length ? <p className="text-sm text-muted-foreground" aria-live="polite">Showing {filtered.length} {unit}{filtered.length === 1 ? "" : "s"} in {groups.length} branch{groups.length === 1 ? "" : "es"}</p> : null}
    </div>
  );
}
