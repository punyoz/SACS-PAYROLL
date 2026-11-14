"use client";

import { PRESENT_FILTER } from "@/lib/attendance/status";
import * as React from "react";
import {
  AlertCircleIcon, CalendarOffIcon, CheckCircle2Icon, CircleSlashIcon, ClockIcon, FilterIcon, HourglassIcon,
  MoreHorizontalIcon, PencilLineIcon, RefreshCwIcon, RotateCcwIcon, SearchIcon, SunriseIcon, TimerOffIcon, XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FilterTabs } from "@/components/portal/filter-tabs";
import { DateRangeFilter } from "@/components/portal/date-range-filter";
import { ExportButtons } from "@/components/portal/export-buttons";
import { useIsMobile } from "@/hooks/use-mobile";
import { SEARCH_MAX } from "@/lib/input-limits";
import { cn } from "@/lib/utils";

/*
 * ONE attendance layout for every role (redesign 2026-11-09). The role
 * decides which controls show, not a separate design:
 *
 *   1 header      title + one help line | Excel, PDF, Refresh (same height)
 *   2 summary     equal tiles: count on top, icon + label under; a tile
 *                 filters the table, the chosen one is highlighted
 *   3 toolbar     ONE row: Search | Date range | Branch | Status | Day | Reset | count
 *                 phones: Search, Date range, then a Filters bottom sheet
 *   4 tabs        work queues with count badges (only where the role uses them)
 *   5 the table   the page's DataTable (server pages, sticky header, cards on phones)
 *   6 footer      the help line, small and muted
 */

/** The statuses of the summary strip, each with an icon (never color alone). */
export const SUMMARY_STATUSES = [
  { status: "On Time", icon: CheckCircle2Icon, tone: "text-success" },
  { status: "Early Bird", icon: SunriseIcon, tone: "text-success" },
  { status: "Late", icon: ClockIcon, tone: "text-gold-text" },
  { status: "Undertime", icon: TimerOffIcon, tone: "text-gold-text" },
  { status: "Half Day", icon: CircleSlashIcon, tone: "text-warning" },
  { status: "Absent", icon: XCircleIcon, tone: "text-destructive" },
  { status: "Incomplete", icon: AlertCircleIcon, tone: "text-muted-foreground" },
  { status: "Corrected", icon: PencilLineIcon, tone: "text-info" },
  { status: "On Leave", icon: CalendarOffIcon, tone: "text-info" },
  { status: "Not tapped yet", icon: HourglassIcon, tone: "text-muted-foreground" },
];
// "Present" first: the group the dashboards count (On Time, Early Bird, Late,
// Undertime, Half Day, Corrected; decision 2026-11-14), so a card's number
// and the filtered rows match.
export const FILTER_STATUSES = [PRESENT_FILTER, ...SUMMARY_STATUSES.map((s) => s.status), "Pending Correction", "Holiday"];

/** 2 · The summary strip. Zero counts stay visible so the layout is stable. */
export function AttendanceSummary({ counts = {}, active = "all", onSelect, loading = false, statuses = SUMMARY_STATUSES }) {
  return (
    <div role="group" aria-label="Filter by status" data-testid="attendance-summary"
      className="grid grid-cols-2 gap-2 min-[480px]:grid-cols-3 sm:grid-cols-5 2xl:grid-cols-10">
      {statuses.map(({ status, icon: Icon, tone }) => {
        const n = Number(counts[status] || 0);
        const on = active === status;
        return (
          <button key={status} type="button" aria-pressed={on} onClick={() => onSelect?.(on ? "all" : status)}
            title={on ? "Show every status" : `Show only ${status}`} data-testid="attendance-tile"
            className={cn(
              "flex min-h-16 min-w-0 flex-col justify-between gap-1 rounded-lg border bg-card px-3 py-2 text-left transition-colors",
              "hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              on && "border-primary bg-primary/5 ring-1 ring-primary",
            )}>
            <span className={cn("text-xl leading-tight font-semibold tabular-nums", !n && "text-muted-foreground")}>{loading ? "…" : n.toLocaleString("en-PH")}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className={cn("size-3.5 shrink-0", tone)} aria-hidden="true" />
              <span className="truncate">{status}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 3 · The toolbar. Every control the same height; phones get Search, the
 * date range and a Filters button (bottom sheet with Branch / Status / Day,
 * Reset and Apply).
 *
 * search:   { value, onChange, placeholder? } | null
 * range:    { value, onChange, maxDays, idPrefix }
 * branch:   { value, onChange, options: [[id, name]] } | null (one-branch roles)
 * status:   { value, onChange, options? } | null
 * day:      { value, onChange, options: [[key, label]] } | null
 * onReset, count
 */
export function AttendanceToolbar({ search, range, branch, status, day, onReset, count = null }) {
  const isMobile = useIsMobile();
  const [sheet, setSheet] = React.useState(false);
  const [draft, setDraft] = React.useState({});
  const live = { branch: branch?.value || "", status: status?.value || "all", day: day?.value || "all" };
  const activeFilters = [live.branch, live.status !== "all" ? 1 : "", live.day !== "all" ? 1 : ""].filter(Boolean).length;
  const setLive = (key, v) => ({ branch: branch?.onChange, status: status?.onChange, day: day?.onChange }[key]?.(v));

  const selects = (values, set, mobile = false) => (
    <>
      {branch ? (
        <div className={mobile ? "space-y-1.5" : "contents"}>
          {mobile ? <Label htmlFor="att-branch-m">Branch</Label> : null}
          <Select value={values.branch || "all"} onValueChange={(v) => set("branch", v === "all" ? "" : v)}>
            <SelectTrigger id={mobile ? "att-branch-m" : undefined} className="w-full lg:w-36" aria-label="Branch" data-testid="att-branch"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {branch.options.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {status ? (
        <div className={mobile ? "space-y-1.5" : "contents"}>
          {mobile ? <Label htmlFor="att-status-m">Status</Label> : null}
          <Select value={values.status || "all"} onValueChange={(v) => set("status", v)}>
            <SelectTrigger id={mobile ? "att-status-m" : undefined} className="w-full lg:w-36" aria-label="Status" data-testid="att-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(status.options || FILTER_STATUSES).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {day ? (
        <div className={mobile ? "space-y-1.5" : "contents"}>
          {mobile ? <Label htmlFor="att-day-m">Day</Label> : null}
          <Select value={values.day || "all"} onValueChange={(v) => set("day", v)}>
            <SelectTrigger id={mobile ? "att-day-m" : undefined} className="w-full lg:w-36" aria-label="Day" data-testid="att-day"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All days</SelectItem>
              {day.options.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </>
  );

  const searchBox = search ? (
    <div className="relative min-w-0 flex-1 lg:min-w-44">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" maxLength={SEARCH_MAX} value={search.value} onChange={(e) => search.onChange(e.target.value)}
        placeholder={search.placeholder || "Search name or employee ID…"} aria-label="Search employees" className="h-10 pl-8 md:h-9" data-testid="att-search" />
    </div>
  ) : null;
  const countText = count !== null
    ? <span role="status" aria-live="polite" className="text-xs whitespace-nowrap text-muted-foreground" data-testid="att-count">{count.toLocaleString("en-PH")} record{count === 1 ? "" : "s"}</span>
    : null;

  if (isMobile) {
    const hasFilters = Boolean(branch || status || day);
    return (
      <div data-slot="attendance-toolbar" className="flex min-w-0 flex-col gap-2 [&_[data-slot=select-trigger]]:h-10 [&_button[data-slot=button]]:min-h-10">
        {searchBox}
        <DateRangeFilter {...range} showReset={false} />
        <div className="flex items-center gap-2">
          {hasFilters ? (
            <Button variant="outline" className="flex-1" onClick={() => { setDraft(live); setSheet(true); }} data-testid="att-filters">
              <FilterIcon aria-hidden="true" />Filters{activeFilters ? ` (${activeFilters})` : ""}
            </Button>
          ) : null}
          {countText}
        </div>
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto" data-testid="att-filter-sheet">
            <SheetHeader><SheetTitle>Filters</SheetTitle><SheetDescription>Choose what the list shows.</SheetDescription></SheetHeader>
            <div className="grid gap-3 px-4 [&_[data-slot=select-trigger]]:h-10">
              {selects(draft, (key, v) => setDraft((c) => ({ ...c, [key]: v })), true)}
            </div>
            <SheetFooter className="flex-row gap-2">
              <Button variant="outline" className="h-10 flex-1" onClick={() => { onReset?.(); setSheet(false); }}><RotateCcwIcon aria-hidden="true" />Reset</Button>
              <Button className="h-10 flex-1" onClick={() => { Object.entries(draft).forEach(([k, v]) => { if (v !== live[k]) setLive(k, v); }); setSheet(false); }}>Apply</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  // One row of controls; the record count sits right under it.
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div data-slot="attendance-toolbar" className="flex min-w-0 flex-wrap items-center gap-2 [&_[data-slot=select-trigger]]:h-9 [&_button[data-slot=button]]:h-9 [&_[data-slot=date-range-filter]_[data-slot=select-trigger]]:w-32">
        {searchBox}
        <DateRangeFilter {...range} showReset={false} className="flex-nowrap" />
        {selects(live, setLive)}
        {onReset ? <Button variant="ghost" size="sm" onClick={onReset} data-testid="att-reset"><RotateCcwIcon aria-hidden="true" />Reset</Button> : null}
      </div>
      {countText ? <div className="flex justify-end">{countText}</div> : null}
    </div>
  );
}

/**
 * The whole view. actions: { onRefresh, refreshing, exportHref, exportLabel,
 * exportDisabled } (any may be left out). tabs: { value, onChange, options }.
 */
export function AttendanceView({ title, help, actions = {}, summary, toolbar, tabs, footer, children, testId = "attendance-view" }) {
  const isMobile = useIsMobile();
  const hasActions = Boolean(actions.onRefresh || actions.exportHref);
  return (
    <Card className="min-w-0 gap-4 py-5 shadow-xs" data-testid={testId}>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {/* 1 · header */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {help ? <p className="text-sm text-muted-foreground">{help}</p> : null}
          </div>
          {!hasActions ? null : isMobile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-10 shrink-0" aria-label="Actions" data-testid="attendance-actions-menu"><MoreHorizontalIcon /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {actions.onRefresh ? <DropdownMenuItem onSelect={actions.onRefresh}><RefreshCwIcon aria-hidden="true" />Refresh</DropdownMenuItem> : null}
                {actions.exportHref ? (
                  <div className="p-1"><ExportButtons href={actions.exportHref} label={actions.exportLabel || "attendance"} disabled={actions.exportDisabled} /></div>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="flex shrink-0 items-center gap-2 [&_button]:h-9" data-testid="attendance-actions">
              {actions.exportHref ? <ExportButtons href={actions.exportHref} label={actions.exportLabel || "attendance"} disabled={actions.exportDisabled} /> : null}
              {actions.onRefresh ? (
                <Button variant="outline" size="sm" onClick={actions.onRefresh} disabled={actions.refreshing}>
                  <RefreshCwIcon className={cn(actions.refreshing && "animate-spin")} aria-hidden="true" />Refresh
                </Button>
              ) : null}
            </div>
          )}
        </div>
        {/* 2 · summary */}
        {summary ? <AttendanceSummary {...summary} /> : null}
        {/* 3 · toolbar */}
        {toolbar ? <AttendanceToolbar {...toolbar} /> : null}
        {/* 4 · queues */}
        {tabs && tabs.options.length > 1 ? (
          <FilterTabs value={tabs.value} onValueChange={tabs.onChange} label="Attendance view" options={tabs.options} />
        ) : null}
        {/* 5 · table */}
        {children}
        {/* 6 · footer */}
        {footer ? <p className="text-xs leading-relaxed text-muted-foreground">{footer}</p> : null}
      </CardContent>
    </Card>
  );
}
