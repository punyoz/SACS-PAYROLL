"use client";

import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/portal/searchable-select";
import { cn } from "@/lib/utils";

/**
 * The ONE filter-bar layout for every list page (2026-11-24):
 *
 *   one row      [ search 280-360 px ][ dropdown ][ dropdown ][ From ][ To ][ sort ]
 *                each dropdown sized to its content (160-240 px); never the page's full width,
 *                never one control per line; it wraps to a second row only when the row is full
 *   phone        an even 2-column grid (the search spans the row; an odd last control widens)
 *
 * Every control is 40 px high with the same corners. Mark the search `data-filter="search"` and a date
 * `data-filter="date"`. Open lists: as wide as the trigger or the longest option (max 320 px), at most
 * 280 px tall with a scroll (src/components/ui/select.jsx); FilterSelect adds a search above 8 options.
 */
export const FILTER_BAR = cn(
  "grid w-full min-w-0 grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap sm:items-center",
  "[&>*]:min-w-0 [&>[data-filter=search]]:col-span-2",
  "sm:[&>[data-filter=search]]:w-auto sm:[&>[data-filter=search]]:min-w-[280px] sm:[&>[data-filter=search]]:max-w-[360px] sm:[&>[data-filter=search]]:flex-[1_1_280px]",
  "[&_[data-slot=select-trigger]]:h-10 [&_[data-slot=select-trigger]]:w-full sm:[&_[data-slot=select-trigger]]:w-auto sm:[&_[data-slot=select-trigger]]:min-w-40 sm:[&_[data-slot=select-trigger]]:max-w-60",
  "[&_input]:h-10 [&_[data-slot=button]]:h-10 [&_[data-slot=button]]:rounded-md [&_input]:rounded-md",
  // Date pickers' buttons carry the popover's slot (2026-11-25: they were 36 px next to 40 px controls).
  "[&_[data-slot=popover-trigger]]:h-10 [&_[data-slot=popover-trigger]]:rounded-md",
  "sm:[&>[data-filter=date]]:w-40",
  "[&>*:last-child:nth-child(even)]:col-span-2 sm:[&>*:last-child:nth-child(even)]:col-span-1",
);

export function FilterBar({ className, children, ...rest }) {
  return <div data-slot="filter-bar" className={cn(FILTER_BAR, className)} {...rest}>{children}</div>;
}

/** A filter dropdown: options [{ value, label }]; a search box inside when there are more than 8. */
export function FilterSelect({ value, onValueChange, options, label, className }) {
  const list = options || [];
  if (list.length > 8) {
    return <SearchableSelect value={value} onValueChange={onValueChange} options={list} aria-label={label} placeholder={label} className={cn("h-10 min-w-40 max-w-60", className)} />;
  }
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label} className={className}><SelectValue /></SelectTrigger>
      <SelectContent>{list.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
