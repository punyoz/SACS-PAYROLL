"use client";

import * as React from "react";
import { PartyPopperIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/portal/empty-state";
import { BACKGROUND, fetchJson } from "@/lib/portal/api";
import { manilaDateKey } from "@/lib/portal/format";

/** The next holidays and suspensions (mountUpcomingHolidays, app.js). */
export function UpcomingHolidaysCard({ refreshKey }) {
  const [state, setState] = React.useState({ loading: true, error: null, holidays: [], today: "" });

  React.useEffect(() => {
    let cancelled = false;
    fetchJson("/api/admin/holidays?upcoming=5", BACKGROUND)
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, holidays: data.holidays || [], today: data.today || manilaDateKey() }); })
      .catch((error) => { if (!cancelled) setState({ loading: false, error: error.message || "Unable to load holidays.", holidays: [], today: "" }); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const todayTime = new Date(`${state.today || "1970-01-01"}T00:00:00+08:00`).getTime();

  return (
    <Card className="min-w-0 shadow-xs">
      <CardHeader>
        <CardTitle>Upcoming holidays</CardTitle>
        <CardDescription>Holidays and suspensions on the calendar</CardDescription>
      </CardHeader>
      <CardContent>
        {state.loading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : state.error ? (
          <ErrorState message={state.error} />
        ) : !state.holidays.length ? (
          <EmptyState icon={PartyPopperIcon} title="No upcoming holidays saved" />
        ) : (
          <ul className="divide-y">
            {state.holidays.map((holiday) => {
              const date = new Date(`${holiday.holiday_date}T00:00:00+08:00`);
              const day = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", day: "numeric" }).format(date);
              const when = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
              const daysAway = Math.round((date.getTime() - todayTime) / 86400000);
              const away = daysAway <= 0 ? "Today" : daysAway === 1 ? "Tomorrow" : `In ${daysAway} days`;
              const kind = [holiday.type_label, holiday.day_part_label].filter(Boolean).join(" · ");
              return (
                <li key={`${holiday.holiday_date}-${holiday.name}`} className="flex items-center gap-3 py-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-gold/15 text-sm font-semibold text-gold-text tabular-nums">{day}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{holiday.name || "Holiday"}</p>
                    <p className="truncate text-xs text-muted-foreground">{when} · {kind}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{away}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
