"use client";

import * as React from "react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { cn } from "@/lib/utils";

/**
 * The portals' table: search, click-to-sort headers, pagination, a skeleton
 * while loading, and friendly empty / error states.
 *
 * columns: [{
 *   key,                      unique id
 *   header,                   heading text
 *   cell?: (row) => node,     defaults to row[key]
 *   sortValue?: (row) => v,   makes the column sortable (or sortable: true to sort by row[key])
 *   searchValue?: (row) => s, text the search box matches (defaults to row[key] for plain columns)
 *   className?, headClassName?, align?: "right" | "center"
 * }]
 *
 * toolbar: a node, or (rows) => node given the searched and sorted rows (for
 * Copy / Export buttons that act on what the search shows).
 */

const PAGE_SIZES = [10, 25, 50, 100];

function sortValueOf(column, row) {
  if (column.sortValue) return column.sortValue(row);
  return row[column.key];
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

export function DataTable({
  columns,
  rows,
  loading = false,
  error = null,
  onRetry,
  rowKey = (row, index) => row.id ?? index,
  rowClassName,
  searchable = true,
  searchPlaceholder = "Search…",
  initialSort = null,
  pageSize: initialPageSize = 10,
  paginate = true,
  toolbar = null,
  empty = { title: "No records yet", description: null },
  caption,
  minWidth,
  className,
}) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState(initialSort);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(initialPageSize);

  const list = React.useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((row) => columns.some((column) => {
      const text = column.searchValue ? column.searchValue(row) : (column.cell ? null : row[column.key]);
      return text !== null && text !== undefined && String(text).toLowerCase().includes(q);
    }));
  }, [list, query, columns]);

  const sorted = React.useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return filtered;
    const factor = sort.dir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => factor * compare(sortValueOf(column, a), sortValueOf(column, b)));
  }, [filtered, sort, columns]);

  const total = sorted.length;
  // The table's own page size is always one of the choices.
  const sizes = [...new Set([initialPageSize, ...PAGE_SIZES])].sort((a, b) => a - b);
  const pageCount = paginate ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const currentPage = Math.min(page, pageCount);
  const start = paginate ? (currentPage - 1) * pageSize : 0;
  const visible = paginate ? sorted.slice(start, start + pageSize) : sorted;

  // A new search or page size starts again from page 1. New rows (a timed
  // refresh) keep the page; currentPage above clamps it if the list shrank.
  React.useEffect(() => { setPage(1); }, [query, pageSize]);

  const toggleSort = (column) => {
    setSort((current) => {
      if (!current || current.key !== column.key) return { key: column.key, dir: "asc" };
      if (current.dir === "asc") return { key: column.key, dir: "desc" };
      return null;
    });
  };

  const alignClass = (align) => (align === "right" ? "text-right" : align === "center" ? "text-center" : "");

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {searchable || toolbar ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {searchable ? (
            <div className="relative sm:max-w-sm sm:flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder.replace(/…$/, "")}
                className="pl-8"
                disabled={loading}
              />
            </div>
          ) : null}
          {toolbar ? <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{typeof toolbar === "function" ? toolbar(sorted) : toolbar}</div> : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table style={minWidth ? { minWidth } : undefined}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader className="bg-muted/60">
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => {
                const sortable = Boolean(column.sortValue || column.sortable);
                const active = sort?.key === column.key ? sort.dir : null;
                return (
                  <TableHead
                    key={column.key}
                    className={cn("h-10 text-xs font-semibold text-muted-foreground", alignClass(column.align), column.headClassName)}
                    aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : sortable ? "none" : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={cn(
                          "-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                          active && "text-foreground",
                        )}
                      >
                        {column.header}
                        {active === "asc" ? <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                          : active === "desc" ? <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                            : <ArrowUpDownIcon className="size-3.5 opacity-50" aria-hidden="true" />}
                      </button>
                    ) : column.header}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  {columns.map((column, c) => (
                    <TableCell key={column.key}>
                      <Skeleton className="h-4" style={{ width: `${55 + ((i * 7 + c * 13) % 40)}%` }} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-0">
                  <ErrorState message={error} onRetry={onRetry} />
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-0 whitespace-normal">
                  {query ? (
                    <EmptyState title="No matches" description={`Nothing matches “${query}”.`} />
                  ) : (
                    <EmptyState title={empty.title} description={empty.description} icon={empty.icon} />
                  )}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row, index) => (
                <TableRow key={rowKey(row, start + index)} className={rowClassName?.(row)}>
                  {columns.map((column) => (
                    <TableCell key={column.key} className={cn(alignClass(column.align), column.className)}>
                      {column.cell ? column.cell(row) : (row[column.key] ?? "—")}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {paginate && !loading && !error && total > 0 ? (
        <div className="flex flex-col-reverse gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite">
            Showing {start + 1}–{Math.min(start + pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">Rows</span>
            <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
              <SelectTrigger size="sm" className="w-18" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sizes.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="tabular-nums">Page {currentPage} of {pageCount}</span>
            <Button variant="outline" size="icon" className="size-8" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page">
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon" className="size-8" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page">
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
