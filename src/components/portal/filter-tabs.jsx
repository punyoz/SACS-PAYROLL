"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Filter tabs for a table's toolbar (2026-11-08): All / Active / Archived and
 * the like, with an optional count on each. Put it in DataTable's `toolbar`
 * so it sits on the same row as the search box on a wide screen, and under
 * it on a phone.
 *
 * Too many tabs for the width: the row scrolls sideways by swipe, trackpad
 * or keyboard, with no scrollbar and no arrow buttons (the stray up / down
 * arrows were a scrollbar of an `overflow-x-auto` wrapper, whose
 * overflow-y then became auto too). Touch targets are 40 px on phones and
 * match the 36 px search box from the md breakpoint up.
 *
 *   <FilterTabs value={filter} onValueChange={setFilter} label="Account status"
 *     options={[{ value: "all", label: "All", count: 7 }, ...]} />
 */
export function FilterTabs({ value, onValueChange, options, label, className, listClassName }) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className={cn("min-w-0 max-w-full gap-0", className)} data-slot="filter-tabs">
      <div className="-mx-1 overflow-x-auto overflow-y-hidden px-1 py-0.5 scrollbar-none">
        <TabsList
          aria-label={label}
          className={cn("w-max group-data-[orientation=horizontal]/tabs:h-auto md:group-data-[orientation=horizontal]/tabs:h-9", listClassName)}
        >
          {options.map((option) => (
            <TabsTrigger key={option.value} value={option.value} className="min-h-10 gap-1.5 px-3 md:min-h-0">
              {option.label}
              {option.count !== undefined && option.count !== null ? (
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{option.count}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}
