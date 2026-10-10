"use client";

import { Skeleton } from "@/components/ui/skeleton";

/*
 * Placeholder while a code-split portal page downloads (next/dynamic in the
 * portal shells). The dashboards and report pages carry the chart library
 * (recharts, ~150 KB gzipped), so they load on demand instead of with the
 * portal's first download.
 */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading page">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
