"use client";

import * as React from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/portal/date-picker";
import { checkRange, defaultRange, MAX_RANGE_DAYS, rangePresets } from "@/lib/portal/date-range";
import { manilaDateKey } from "@/lib/payroll/periods";
import { cn } from "@/lib/utils";

/**
 * From / To dates with quick choices (This cutoff, Last cutoff, This month,
 * Last month) and Reset, for every attendance list (alpha test A1). Manila
 * days. It only reports a range that is valid; a wrong one shows why.
 *
 *   const [range, setRange] = React.useState(defaultRange());
 *   <DateRangeFilter value={range} onChange={setRange} count={total} />
 */
export function DateRangeFilter({ value, onChange, count = null, maxDays = MAX_RANGE_DAYS, idPrefix = "range", className }) {
  const today = manilaDateKey();
  const presets = React.useMemo(() => rangePresets(today), [today]);
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => { setDraft(value); }, [value]);
  const checked = checkRange(draft, maxDays);
  const preset = presets.find((p) => p.from === value?.from && p.to === value?.to)?.id || "custom";

  const apply = (next) => {
    setDraft(next);
    if (!checkRange(next, maxDays).error) onChange(next);
  };
  const reset = () => apply(defaultRange(today));
  const isDefault = preset === "this_cutoff";

  return (
    <div data-slot="date-range-filter" className={cn("flex flex-wrap items-center gap-2", className)}>
      <Select value={preset} onValueChange={(id) => { const p = presets.find((x) => x.id === id); if (p) apply({ from: p.from, to: p.to }); }}>
        <SelectTrigger className="w-36" aria-label="Quick range"><SelectValue /></SelectTrigger>
        <SelectContent>
          {presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
          {/* Only shown (as the label) while two dates of one's own are chosen. */}
          {preset === "custom" ? <SelectItem value="custom">Custom range</SelectItem> : null}
        </SelectContent>
      </Select>
      <DatePicker id={`${idPrefix}-from`} value={draft?.from || ""} max={draft?.to || undefined} placeholder="From" aria-label="From date" className="w-auto"
        onChange={(from) => apply({ ...draft, from: from || "" })} aria-invalid={Boolean(checked.error) || undefined} />
      <span className="text-sm text-muted-foreground" aria-hidden="true">to</span>
      <DatePicker id={`${idPrefix}-to`} value={draft?.to || ""} min={draft?.from || undefined} placeholder="To" aria-label="To date" className="w-auto"
        onChange={(to) => apply({ ...draft, to: to || "" })} aria-invalid={Boolean(checked.error) || undefined} />
      {!isDefault ? <Button type="button" variant="ghost" size="sm" onClick={reset}><RotateCcwIcon aria-hidden="true" />Reset</Button> : null}
      {checked.error ? <span role="alert" className="text-xs text-destructive">{checked.error}</span>
        : count !== null ? <span role="status" aria-live="polite" className="text-xs whitespace-nowrap text-muted-foreground">{count.toLocaleString("en-PH")} record{count === 1 ? "" : "s"}</span> : null}
    </div>
  );
}

export { defaultRange };
