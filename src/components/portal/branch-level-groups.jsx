"use client";

import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/portal/empty-state";
import { TableToolbar } from "@/components/portal/table-toolbar";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/**
 * Rows grouped by branch, then by level inside each branch (Work Schedules,
 * 2026-11-16). Every branch is a one-line collapsible heading (all closed at
 * first, so every branch fits on one screen); each level inside is
 * collapsible too and shows at most `limit` rows until "Show all". A box on
 * every heading selects everyone in it, hidden rows included; it shows the
 * partial state when only some are. Search or a filter opens the matching
 * branches and shows every match. Which sections are open lives only in
 * this component (this visit).
 *
 * columns: [{ key, header, cell(row), className? }] laid out on one line by
 *   `gridClassName` from md up, stacked as a card below it.
 * groupOf(row) / groupLabel(row): the branch; the group whose key is
 *   `lastGroup` ("No branch") comes last. subgroupOf(row) / subgroupLabel(key):
 *   the level; subgroupOrder: level keys in display order.
 * filters: [{ id, label, allLabel, options: [{ value, label }], test(row, value) }].
 * summary(rows): the heading's short summary ("20 employees · 18 Default").
 */
export function BranchLevelGroups({
  columns,
  gridClassName,
  rows,
  rowLabel = (row) => row.full_name,
  groupOf,
  groupLabel,
  lastGroup = "none",
  subgroupOf,
  subgroupLabel,
  subgroupOrder = [],
  selectable = false,
  selected,
  onSelectedChange,
  search,
  searchPlaceholder = "Search…",
  filters = [],
  summary,
  loading = false,
  empty = "No employees",
  unit = "employee",
  limit = 10,
  testIdPrefix = "ws",
}) {
  const [query, setQuery] = React.useState("");
  const [values, setValues] = React.useState({});
  const [open, setOpen] = React.useState(() => new Set());
  const [closedLevels, setClosedLevels] = React.useState(() => new Set());
  const [showAll, setShowAll] = React.useState(() => new Set());

  const q = query.trim().toLowerCase();
  const activeFilters = filters.filter((f) => values[f.id] && values[f.id] !== ALL);
  const narrowed = Boolean(q) || activeFilters.length > 0;

  const filtered = React.useMemo(() => rows.filter((row) => (!q || !search || String(search(row) || "").toLowerCase().includes(q))
    && activeFilters.every((f) => f.test(row, values[f.id]))),
  // activeFilters is derived from filters + values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, q, search, filters, values]);

  // Branch -> level -> rows; branches alphabetical with "No branch" last, levels in order, names alphabetical.
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
      .sort((a, b) => (a.key === lastGroup) - (b.key === lastGroup) || String(a.label).localeCompare(String(b.label)))
      .map((group) => {
        const bySub = new Map();
        group.rows.forEach((row) => {
          const s = subgroupOf(row);
          if (!bySub.has(s)) bySub.set(s, []);
          bySub.get(s).push(row);
        });
        const subgroups = [...bySub.entries()]
          .sort(([a], [b]) => rank(a) - rank(b))
          .map(([key, list]) => ({ key, label: subgroupLabel(key), rows: list.sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""))) }));
        return { ...group, rows: subgroups.flatMap((s) => s.rows), subgroups };
      });
  }, [filtered, groupOf, groupLabel, lastGroup, subgroupOf, subgroupLabel, subgroupOrder]);

  // A search or filter opens every branch with a match.
  const narrowKey = narrowed ? `${q}|${JSON.stringify(values)}` : "";
  React.useEffect(() => {
    if (narrowKey) setOpen(new Set(groups.map((g) => g.key)));
    // Only a new search / filter re-opens; the user's own toggles stay otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrowKey]);

  const flip = (setter, key) => setter((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const selectedIn = (list) => list.filter((row) => selected?.has(row.id)).length;
  const toggle = (list) => {
    const all = list.length > 0 && selectedIn(list) === list.length;
    const next = new Set(selected);
    list.forEach((row) => (all ? next.delete(row.id) : next.add(row.id)));
    onSelectedChange(next);
  };
  // A heading's box: the whole list under it, shown or not.
  const headingBox = (list, label) => {
    const n = selectedIn(list);
    return (
      <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center">
        <Checkbox
          checked={n === 0 ? false : n === list.length ? true : "indeterminate"}
          onCheckedChange={() => toggle(list)}
          aria-label={`Select all in ${label}`}
        />
      </label>
    );
  };
  const plural = (n, word = unit) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const rowView = (row) => (
    <li key={row.id} data-testid={`${testIdPrefix}-row`} data-state={selected?.has(row.id) ? "selected" : undefined}
      className="flex items-start gap-1 border-t px-1 py-1 first:border-t-0 data-[state=selected]:bg-primary/5 md:items-center">
      {selectable ? (
        <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center">
          <Checkbox
            checked={selected?.has(row.id) || false}
            onCheckedChange={(v) => { const next = new Set(selected); if (v === true) next.add(row.id); else next.delete(row.id); onSelectedChange(next); }}
            aria-label={`Select ${rowLabel(row)}`}
          />
        </label>
      ) : null}
      <div className={cn("grid min-w-0 flex-1 gap-1 py-1.5 text-sm md:items-center md:gap-3 md:py-0", gridClassName)}>
        {columns.map((column) => <div key={column.key} className={cn("min-w-0", column.className)}>{column.cell(row)}</div>)}
      </div>
    </li>
  );

  const columnHeads = (
    <div className={cn("hidden px-1 text-xs font-semibold text-muted-foreground md:flex md:items-center md:gap-1")} aria-hidden="true">
      {selectable ? <span className="w-10 shrink-0" /> : null}
      <div className={cn("grid min-w-0 flex-1 gap-3", gridClassName)}>
        {columns.map((column) => <span key={column.key} className={column.headerClassName}>{column.header}</span>)}
      </div>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TableToolbar search={search ? { value: query, onChange: setQuery, placeholder: searchPlaceholder } : null}>
        {filters.map((f) => (
          <Select key={f.id} value={values[f.id] || ALL} onValueChange={(v) => setValues((c) => ({ ...c, [f.id]: v }))}>
            <SelectTrigger className="w-auto min-w-36" aria-label={f.label}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{f.allLabel || `All (${f.label})`}</SelectItem>
              {f.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ))}
        <Button variant="outline" size="sm" onClick={() => setOpen(new Set(groups.map((g) => g.key)))}>Expand all</Button>
        <Button variant="outline" size="sm" onClick={() => setOpen(new Set())}>Collapse all</Button>
      </TableToolbar>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : !filtered.length ? (
        <div className="rounded-lg border"><EmptyState title={narrowed ? "No employees match" : empty} /></div>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => {
            const isOpen = open.has(group.key);
            const panelId = `${testIdPrefix}-branch-${group.key}`;
            return (
              <li key={group.key} className="rounded-lg border bg-card">
                <div data-testid={`${testIdPrefix}-branch`} data-branch={group.label} className={cn("flex items-center gap-1 rounded-lg bg-primary/8 pr-2", isOpen && "rounded-b-none")}>
                  {selectable ? headingBox(group.rows, group.label) : <span className="w-2" />}
                  <button type="button" aria-expanded={isOpen} aria-controls={panelId} onClick={() => flip(setOpen, group.key)}
                    className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-primary">{group.label}</span>
                      <span className="text-xs text-muted-foreground"> · {summary ? summary(group.rows) : plural(group.rows.length)}</span>
                    </span>
                    <ChevronDownIcon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                  </button>
                </div>
                {isOpen ? (
                  <div id={panelId} className="space-y-2 p-2">
                    {columnHeads}
                    {group.subgroups.map((sub) => {
                      const key = `${group.key}|${sub.key}`;
                      const subOpen = !closedLevels.has(key);
                      const all = narrowed || showAll.has(key);
                      const shown = all ? sub.rows : sub.rows.slice(0, limit);
                      const subId = `${panelId}-${sub.key}`;
                      return (
                        <div key={sub.key} className="rounded-md border">
                          <div data-testid={`${testIdPrefix}-level`} data-count={sub.rows.length} className="flex items-center gap-1 bg-muted/40 pr-2">
                            {selectable ? headingBox(sub.rows, `${group.label}, ${sub.label}`) : <span className="w-2" />}
                            <button type="button" aria-expanded={subOpen} aria-controls={subId} onClick={() => flip(setClosedLevels, key)}
                              className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                              <span className="min-w-0 flex-1"><span className="font-medium">{sub.label}</span><span className="text-xs text-muted-foreground"> · {plural(sub.rows.length)}</span></span>
                              <ChevronDownIcon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", subOpen && "rotate-180")} />
                            </button>
                          </div>
                          {subOpen ? (
                            <div id={subId}>
                              <ul>{shown.map(rowView)}</ul>
                              {!all && sub.rows.length > limit ? (
                                <div className="border-t p-1">
                                  <Button variant="ghost" size="sm" className="h-10 w-full md:h-8" onClick={() => flip(setShowAll, key)}>Show all {sub.rows.length}</Button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {!loading && filtered.length ? <p className="text-sm text-muted-foreground" aria-live="polite">Showing {plural(filtered.length)} in {groups.length} branch{groups.length === 1 ? "" : "es"}</p> : null}
    </div>
  );
}
