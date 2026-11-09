"use client";

import * as React from "react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { TableToolbar } from "@/components/portal/table-toolbar";
import { useIsMobile } from "@/hooks/use-mobile";
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
 *
 * Phones (below 768px, alpha test B): each row is a card instead of a wide
 * table row: the first column (or the one marked mobilePrimary) is the
 * card's title, the others are "Label: value" lines, and columns without a
 * text heading (actions) sit at the bottom. Column options: mobile: false
 * hides a column on cards; mobileLabel overrides its label. mobileCards={false}
 * keeps the scrolling table (e.g. a grid that only makes sense as a table).
 * Only one of the two is rendered, so nothing appears twice on the page.
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
  // Server-side paging and search for long lists (scale test 2026-10-22):
  // { total, page, pageSize, query, onChange({ page?, pageSize?, query? }) }.
  // The rows given are the current page; search and paging ask the server.
  server = null,
  mobileCards = true,
}) {
  const isMobile = useIsMobile();
  const asCards = mobileCards && isMobile;
  const [query, setQuery] = React.useState(server ? server.query || "" : "");
  const [sort, setSort] = React.useState(initialSort);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(initialPageSize);

  const list = React.useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || server) return list;
    return list.filter((row) => columns.some((column) => {
      const text = column.searchValue ? column.searchValue(row) : (column.cell ? null : row[column.key]);
      return text !== null && text !== undefined && String(text).toLowerCase().includes(q);
    }));
  }, [list, query, columns, server]);

  const sorted = React.useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return filtered;
    const factor = sort.dir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => factor * compare(sortValueOf(column, a), sortValueOf(column, b)));
  }, [filtered, sort, columns]);

  const total = server ? Number(server.total || 0) : sorted.length;
  const sizeNow = server ? Number(server.pageSize || initialPageSize) : pageSize;
  // The table's own page size is always one of the choices.
  const sizes = [...new Set([initialPageSize, sizeNow, ...PAGE_SIZES])].sort((a, b) => a - b);
  const pageCount = paginate ? Math.max(1, Math.ceil(total / sizeNow)) : 1;
  const currentPage = server ? Math.min(Number(server.page || 1), pageCount) : Math.min(page, pageCount);
  const start = paginate ? (currentPage - 1) * sizeNow : 0;
  const visible = server ? sorted : (paginate ? sorted.slice(start, start + pageSize) : sorted);
  const goTo = (next) => (server ? server.onChange({ page: next }) : setPage(next));
  const resize = (size) => (server ? server.onChange({ pageSize: size, page: 1 }) : setPageSize(size));

  // A new search or page size starts again from page 1. New rows (a timed
  // refresh) keep the page; currentPage above clamps it if the list shrank.
  React.useEffect(() => { if (!server) setPage(1); }, [query, pageSize, server]);
  // Server mode: the search goes to the server once typing pauses.
  const onServerChange = server?.onChange;
  const serverQuery = server?.query || "";
  React.useEffect(() => {
    if (!onServerChange || query === serverQuery) return undefined;
    const timer = setTimeout(() => onServerChange({ query, page: 1 }), 350);
    return () => clearTimeout(timer);
  }, [query, serverQuery, onServerChange]);

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
      {/* Search first, then the filters and buttons on the same row (TableToolbar, 2026-11-08). */}
      {searchable || toolbar ? (
        <TableToolbar search={searchable ? { value: query, onChange: setQuery, placeholder: searchPlaceholder, disabled: loading && !server } : null}>
          {toolbar ? (typeof toolbar === "function" ? toolbar(sorted) : toolbar) : null}
        </TableToolbar>
      ) : null}

      {/* A failed refresh never empties a table that already has rows: they
          stay, with the error and a retry above them. */}
      {error && (rows || []).length ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error} Showing the last loaded data.</span>
          {onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : null}
        </div>
      ) : null}
      {asCards ? (
        <MobileCards
          columns={columns}
          rows={visible}
          loading={loading}
          error={error && !(rows || []).length ? error : null}
          onRetry={onRetry}
          rowKey={(row, index) => rowKey(row, start + index)}
          rowClassName={rowClassName}
          empty={query ? { title: "No matches", description: `Nothing matches “${query}”.` } : empty}
          caption={caption}
        />
      ) : (
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
                          // Right-aligned columns put the arrow first so the heading text lines up with the numbers below.
                          column.align === "right" && "flex-row-reverse",
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
            ) : error && !(rows || []).length ? (
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
      )}

      {paginate && !loading && total > 0 ? (
        <div className="flex flex-col-reverse gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite">
            Showing {start + 1}–{Math.min(start + sizeNow, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">Rows</span>
            <Select value={String(sizeNow)} onValueChange={(value) => resize(Number(value))}>
              <SelectTrigger size="sm" className="w-18" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sizes.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="tabular-nums">Page {currentPage} of {pageCount}</span>
            <Button variant="outline" size="icon" className="size-8" onClick={() => goTo(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page">
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon" className="size-8" onClick={() => goTo(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page">
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A column's label on a card: its heading when that is text. */
function cardLabel(column) {
  if (column.mobileLabel) return column.mobileLabel;
  return typeof column.header === "string" ? column.header : null;
}

/** Phone layout: one card per row (see the DataTable notes above). */
function MobileCards({ columns, rows, loading, error, onRetry, rowKey, rowClassName, empty, caption }) {
  const shown = columns.filter((column) => column.mobile !== false);
  const primary = shown.find((column) => column.mobilePrimary) || shown[0];
  const lines = shown.filter((column) => column !== primary && cardLabel(column));
  const trailing = shown.filter((column) => column !== primary && !cardLabel(column));
  const value = (column, row) => (column.cell ? column.cell(row) : (row[column.key] ?? "—"));

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={`skc-${i}`} className="space-y-2 rounded-lg border bg-card p-3">
            <Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    );
  }
  if (error) return <div className="rounded-lg border bg-card"><ErrorState message={error} onRetry={onRetry} /></div>;
  if (!rows.length) {
    return <div className="rounded-lg border bg-card"><EmptyState title={empty.title} description={empty.description} icon={empty.icon} /></div>;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label={caption || undefined} data-slot="data-table-cards">
      {rows.map((row, index) => (
        <li key={rowKey(row, index)} data-slot="data-table-card" className={cn("min-w-0 overflow-hidden rounded-lg border bg-card p-3 text-sm shadow-xs [overflow-wrap:anywhere]", rowClassName?.(row))}>
          {primary ? <div className="min-w-0 font-medium [&_*]:max-w-full [&_*]:whitespace-normal [&_*]:[overflow-wrap:anywhere]">{value(primary, row)}</div> : null}
          {lines.length ? (
            <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              {lines.map((column) => (
                <React.Fragment key={column.key}>
                  <dt className="text-xs text-muted-foreground">{cardLabel(column)}</dt>
                  <dd className="min-w-0 break-words [&_*]:whitespace-normal">{value(column, row)}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}
          {trailing.length ? (
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t pt-2">
              {trailing.map((column) => <React.Fragment key={column.key}>{value(column, row)}</React.Fragment>)}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
