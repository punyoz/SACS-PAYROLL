"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { cn } from "@/lib/utils";

/**
 * A table whose rows sit under one heading per group (HR Reports and the
 * Transfer Requests branch list, public/legacy/js/hr.js): the heading
 * repeats at the top of every page and counts the whole filtered group.
 * `rows` must already be sorted by group.
 *
 * groupOf(row) -> key, groupLabel(key, row) -> text,
 * search(row) -> haystack (optional; adds a search box).
 */
export function BranchGroupedTable({
  columns,
  rows,
  groupOf,
  groupLabel,
  search,
  searchPlaceholder = "Search…",
  pageSize = 20,
  loading = false,
  error = null,
  onRetry,
  empty = "No records found.",
  unit = "employee",
  toolbar,
  caption,
  minWidth = 760,
  rowKey = (row, i) => row.id || i,
}) {
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  React.useEffect(() => { setPage(1); }, [query, rows]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && search ? rows.filter((row) => String(search(row) || "").toLowerCase().includes(q)) : rows;
  }, [rows, query, search]);

  const counts = React.useMemo(() => {
    const map = new Map();
    filtered.forEach((row) => map.set(groupOf(row), (map.get(groupOf(row)) || 0) + 1));
    return map;
  }, [filtered, groupOf]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);

  const body = [];
  let last = null;
  visible.forEach((row, index) => {
    const key = groupOf(row);
    if (key !== last) {
      last = key;
      const n = counts.get(key) || 0;
      body.push(
        <TableRow key={`g-${key}-${index}`} className="bg-primary/8 hover:bg-primary/8">
          <TableCell colSpan={columns.length} className="py-2">
            <span className="font-semibold text-primary">{groupLabel(key, row)}</span>
            <span className="ml-2 text-xs text-muted-foreground">{n} {unit}{n === 1 ? "" : "s"}</span>
          </TableCell>
        </TableRow>,
      );
    }
    body.push(
      <TableRow key={rowKey(row, start + index)}>
        {columns.map((column) => (
          <TableCell key={column.key} className={cn(column.align === "right" && "text-right", column.className)}>{column.cell(row)}</TableCell>
        ))}
      </TableRow>,
    );
  });

  return (
    <div className="flex flex-col gap-3">
      {search || toolbar ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {search ? (
            <div className="relative sm:max-w-sm sm:flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input type="search" className="pl-8" placeholder={searchPlaceholder} aria-label={searchPlaceholder.replace(/…$/, "")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          ) : null}
          {toolbar ? <div className="flex flex-wrap gap-2 sm:ml-auto">{toolbar}</div> : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border bg-card">
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
            )) : error ? (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={columns.length} className="p-0 whitespace-normal"><ErrorState message={error} onRetry={onRetry} /></TableCell></TableRow>
            ) : !filtered.length ? (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={columns.length} className="p-0 whitespace-normal"><EmptyState title={query ? "No records match your search." : empty} /></TableCell></TableRow>
            ) : body}
          </TableBody>
        </Table>
      </div>
      {!loading && !error && filtered.length > pageSize ? (
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <p aria-live="polite">Showing {start + 1}–{Math.min(start + pageSize, filtered.length)} of {filtered.length}</p>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">Page {current} of {pageCount}</span>
            <Button variant="outline" size="icon" className="size-8" onClick={() => setPage(current - 1)} disabled={current <= 1} aria-label="Previous page"><ChevronLeftIcon /></Button>
            <Button variant="outline" size="icon" className="size-8" onClick={() => setPage(current + 1)} disabled={current >= pageCount} aria-label="Next page"><ChevronRightIcon /></Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
