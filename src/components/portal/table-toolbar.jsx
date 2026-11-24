"use client";

import * as React from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SEARCH_MAX } from "@/lib/input-limits";
import { FILTER_BAR } from "@/components/portal/filter-bar";

/**
 * The one toolbar row above a table (2026-11-08), used by DataTable and
 * BranchGroupedTable, and by any page that lays out its own filters:
 *
 *   one row             [ search 280-360 px ][ tabs ][ dropdowns ][ buttons ]  (each its own size, 40 px)
 *   phone               an even 2-column grid (the search spans the row)
 *
 * The search box keeps its own behaviour (what it matches is up to the table).
 */
export function TableToolbar({ search, children, className }) {
  const hasTools = React.Children.toArray(children).some(Boolean);
  if (!search && !hasTools) return null;
  // The one filter-bar layout (src/components/portal/filter-bar.jsx, 2026-11-24): search 280-360 px, then the
  // dropdowns and buttons on the same row, each its own size; a 2-column grid on a phone.
  return (
    <div data-slot="table-toolbar" className={cn(FILTER_BAR, className)}>
      {search ? (
        <div className="relative" data-filter="search">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            maxLength={SEARCH_MAX}
            aria-label={String(search.placeholder || "Search").replace(/…$/, "")}
            className="pl-8"
            disabled={search.disabled}
          />
        </div>
      ) : null}
      {hasTools ? <div data-slot="table-toolbar-tools" className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1 sm:flex-[1_1_0%]">{children}</div> : null}
    </div>
  );
}
