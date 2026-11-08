"use client";

import * as React from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SEARCH_MAX } from "@/lib/input-limits";

/**
 * The one toolbar row above a table (2026-11-08), used by DataTable and
 * BranchGroupedTable, and by any page that lays out its own filters:
 *
 *   wide screen (lg+)   [ search, taking the remaining width ][ tabs ][ dropdowns ][ buttons ]
 *                       all on one row, the same height (36 px), centred
 *   tablet / phone      [ search, full width                            ]
 *                       [ tabs ][ dropdowns ][ buttons ]  → swipe sideways, no scrollbar
 *                       (40 px touch targets; never a horizontal page scroll)
 *
 * The search box keeps its own behaviour (what it matches is up to the table).
 */
export function TableToolbar({ search, children, className }) {
  const hasTools = React.Children.toArray(children).some(Boolean);
  if (!search && !hasTools) return null;
  return (
    <div data-slot="table-toolbar" className={cn("flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center", className)}>
      {search ? (
        <div className="relative w-full min-w-0 lg:min-w-64 lg:flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            maxLength={SEARCH_MAX}
            aria-label={String(search.placeholder || "Search").replace(/…$/, "")}
            className="h-10 pl-8 md:h-9"
            disabled={search.disabled}
          />
        </div>
      ) : null}
      {hasTools ? (
        <div
          data-slot="table-toolbar-tools"
          className={cn(
            "-mx-1 flex min-w-0 items-center gap-2 overflow-x-auto overflow-y-hidden px-1 py-0.5 scrollbar-none *:shrink-0",
            "lg:mx-0 lg:flex-wrap lg:justify-end lg:overflow-visible lg:px-0 lg:*:shrink",
            "[&_[data-slot=select-trigger]]:h-10 md:[&_[data-slot=select-trigger]]:h-9 [&_[data-slot=button]]:h-10 md:[&_[data-slot=button]]:h-9",
            !search && "lg:justify-start",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
