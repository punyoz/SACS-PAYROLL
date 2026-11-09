"use client";

import * as React from "react";
import { CalendarRangeIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/portal/date-picker";
import { checkRange, defaultRange, MAX_RANGE_DAYS, rangePresets } from "@/lib/portal/date-range";
import { manilaDateKey } from "@/lib/payroll/periods";
import { useUrlParam } from "@/components/portal/use-url-param";
import { cn } from "@/lib/utils";

/**
 * The one date range control (alpha test A1; attendance redesign 2026-11-09):
 * a preset (This cutoff, Last cutoff, This month, Last month, Custom) and ONE
 * button showing the range, which opens a popover with From and To together.
 * Manila days. A range with To before From, or longer than `maxDays`, is not
 * applied: the popover says why.
 *
 *   const [range, setRange] = useUrlRange("att", defaultRange());
 *   <DateRangeFilter value={range} onChange={setRange} count={total} />
 *
 * `showReset` adds a Reset (pages without their own toolbar Reset).
 */
export function DateRangeFilter({ value, onChange, count = null, maxDays = MAX_RANGE_DAYS, idPrefix = "range", className, showReset = true }) {
  const today = manilaDateKey();
  const presets = React.useMemo(() => rangePresets(today), [today]);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => { setDraft(value); }, [value]);
  const checked = checkRange(draft, maxDays);
  const preset = presets.find((p) => p.from === value?.from && p.to === value?.to)?.id || "custom";
  const isDefault = preset === "this_cutoff";

  const choosePreset = (id) => {
    if (id === "custom") { setOpen(true); return; }
    const p = presets.find((x) => x.id === id);
    if (p) onChange({ from: p.from, to: p.to });
  };
  const apply = () => {
    if (checked.error) return;
    onChange({ from: draft.from, to: draft.to });
    setOpen(false);
  };
  const label = rangeLabel(value);

  return (
    <div data-slot="date-range-filter" className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      <Select value={preset} onValueChange={choosePreset}>
        <SelectTrigger className="w-36" aria-label="Date range"><SelectValue /></SelectTrigger>
        <SelectContent>
          {presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
          <SelectItem value="custom">Custom…</SelectItem>
        </SelectContent>
      </Select>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setDraft(value); }}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" id={`${idPrefix}-range`} className="min-w-0 justify-start gap-2 font-normal tabular-nums" aria-label={`Dates: ${label}. Change`}>
            <CalendarRangeIcon className="size-4 opacity-70" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-from`}>From</Label>
              <DatePicker id={`${idPrefix}-from`} value={draft?.from || ""} placeholder="From" onChange={(from) => setDraft((c) => ({ ...c, from: from || "" }))} aria-invalid={Boolean(checked.error) || undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-to`}>To</Label>
              <DatePicker id={`${idPrefix}-to`} value={draft?.to || ""} placeholder="To" onChange={(to) => setDraft((c) => ({ ...c, to: to || "" }))} aria-invalid={Boolean(checked.error) || undefined} />
            </div>
          </div>
          <p className={cn("text-xs", checked.error ? "text-destructive" : "text-muted-foreground")} role={checked.error ? "alert" : undefined}>
            {checked.error || `Up to ${maxDays} days. Philippine time.`}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(value); setOpen(false); }}>Cancel</Button>
            <Button type="button" size="sm" onClick={apply} disabled={Boolean(checked.error)} data-testid={`${idPrefix}-apply`}>Apply</Button>
          </div>
        </PopoverContent>
      </Popover>
      {showReset && !isDefault ? <Button type="button" variant="ghost" size="sm" onClick={() => onChange(defaultRange(today))}><RotateCcwIcon aria-hidden="true" />Reset</Button> : null}
      {count !== null ? <span role="status" aria-live="polite" className="text-xs whitespace-nowrap text-muted-foreground">{count.toLocaleString("en-PH")} record{count === 1 ? "" : "s"}</span> : null}
    </div>
  );
}

const SHORT = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
const LONG = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
const at = (key) => new Date(`${key}T00:00:00+08:00`);

/** "Nov 1 – 15, 2026", "Oct 16 – Nov 15, 2026", "Dec 16, 2026 – Jan 15, 2027". */
export function rangeLabel(range) {
  if (!range?.from || !range?.to) return "Choose dates";
  if (range.from === range.to) return LONG.format(at(range.from));
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const sameMonth = sameYear && range.from.slice(5, 7) === range.to.slice(5, 7);
  if (sameMonth) return `${SHORT.format(at(range.from))} – ${Number(range.to.slice(8, 10))}, ${range.to.slice(0, 4)}`;
  return `${sameYear ? SHORT.format(at(range.from)) : LONG.format(at(range.from))} – ${LONG.format(at(range.to))}`;
}

/**
 * A date range kept in the address (?<key>_from=&<key>_to=), so Refresh and
 * Back keep it (redesign 2026-11-09). Falls back to `fallback`.
 */
export function useUrlRange(key, fallback) {
  const [from, setFrom] = useUrlParam(`${key}_from`, fallback.from);
  const [to, setTo] = useUrlParam(`${key}_to`, fallback.to);
  const value = React.useMemo(() => {
    const candidate = { from, to };
    return checkRange(candidate, 366).error ? fallback : candidate;
  }, [from, to, fallback]);
  const set = React.useCallback((next) => { setFrom(next.from); setTo(next.to); }, [setFrom, setTo]);
  return [value, set];
}

export { defaultRange };
