"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** "YYYY-MM-DD" <-> a local Date at midnight (the API speaks date keys). */
function keyToDate(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

function dateToKey(date) {
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * A date field: a button that opens the shadcn Calendar in a popover. The
 * value is a "YYYY-MM-DD" string, the same as an <input type="date">; `min`
 * and `max` (also date keys) limit the days that can be picked.
 */
export const DatePicker = React.forwardRef(function DatePicker(
  { id, value, onChange, placeholder = "Pick a date", disabled, className, min, max, "aria-invalid": invalid, ...props },
  ref,
) {
  const [open, setOpen] = React.useState(false);
  const selected = keyToDate(value);
  const minDate = keyToDate(min);
  const maxDate = keyToDate(max);
  const limits = [minDate ? { before: minDate } : null, maxDate ? { after: maxDate } : null].filter(Boolean);
  const label = selected
    ? selected.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={ref}
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-invalid={invalid}
          className={cn("w-full justify-start gap-2 font-normal", !selected && "text-muted-foreground", className)}
          {...props}
        >
          <CalendarIcon className="size-4 opacity-70" aria-hidden="true" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected || maxDate}
          captionLayout="dropdown"
          disabled={limits.length ? limits : undefined}
          startMonth={minDate}
          endMonth={maxDate}
          onSelect={(date) => {
            onChange?.(dateToKey(date));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
});
