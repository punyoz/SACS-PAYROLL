"use client";

import * as React from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/**
 * A dropdown for long lists (2026-11-08): regions, provinces, cities and
 * barangays, employees, positions. Type to filter instantly; arrow keys move,
 * Enter picks, Escape closes; "No results" when nothing matches.
 *
 *   desktop  a list under the box (above it when there is no room), at most
 *            about 300 px tall, scrolling normally, kept on screen and inside
 *            a dialog; no up / down arrow buttons
 *   phone    a sheet from the bottom of the screen, search box at the top,
 *            the list filling the rest
 *
 * Drop-in for a Select: the same value / onValueChange, an id the Label
 * points at (and that a form can focus on an error), aria-invalid, disabled.
 *
 *   <SearchableSelect id="x" value={v} onValueChange={setV} placeholder="Select city"
 *     options={[{ value, label, group?, description?, disabled?, keywords? }]} />
 */

const fold = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// The same look as the shadcn Select box (src/components/ui/select.jsx).
const TRIGGER = "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-left text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40";

function OptionList({ listId, options, value, active, setActive, onPick, emptyText, className }) {
  const listRef = React.useRef(null);
  React.useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);
  let lastGroup;
  return (
    <div ref={listRef} id={listId} role="listbox" className={cn("overflow-y-auto overscroll-contain p-1", className)}>
      {options.length ? options.map((option, index) => {
        const header = option.group && option.group !== lastGroup ? option.group : null;
        lastGroup = option.group;
        const selected = String(option.value) === String(value ?? "");
        return (
          <React.Fragment key={option.value}>
            {header ? <div role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{header}</div> : null}
            <div
              id={`${listId}-${index}`}
              role="option"
              data-index={index}
              aria-selected={selected}
              aria-disabled={option.disabled || undefined}
              onPointerMove={() => { if (!option.disabled && active !== index) setActive(index); }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { if (!option.disabled) onPick(option); }}
              className={cn(
                "relative flex min-h-9 cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none",
                index === active && "bg-accent text-accent-foreground",
                option.disabled && "pointer-events-none opacity-50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words">{option.label}</span>
                {option.description ? <span className="block text-xs text-muted-foreground">{option.description}</span> : null}
              </span>
              {selected ? <CheckIcon className="absolute right-2 size-4" aria-hidden="true" /> : null}
            </div>
          </React.Fragment>
        );
      }) : <p role="status" className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>}
    </div>
  );
}

export function SearchableSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Type to search…",
  emptyText = "No results",
  label,
  disabled = false,
  className,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  // Inside a dialog the list stays inside the dialog's box (flips up or
  // shrinks to fit); elsewhere, inside the screen.
  const [boundary, setBoundary] = React.useState(null);
  const reactId = React.useId();
  const listId = `${id || reactId}-list`;

  const list = React.useMemo(() => options || [], [options]);
  const selected = list.find((o) => String(o.value) === String(value ?? "")) || null;
  const filtered = React.useMemo(() => {
    const q = fold(query.trim());
    if (!q) return list;
    return list.filter((o) => fold(`${o.label} ${o.description || ""} ${o.keywords || ""} ${o.group || ""}`).includes(q));
  }, [list, query]);

  // Opening shows the chosen one; typing starts from the first match.
  React.useEffect(() => {
    if (!open) return;
    setBoundary(triggerRef.current?.closest('[role="dialog"], [role="alertdialog"]') || null);
    setQuery("");
    const at = list.findIndex((o) => String(o.value) === String(value ?? ""));
    setActive(at >= 0 ? at : Math.max(0, list.findIndex((o) => !o.disabled)));
    // The sheet / popover mounts first; then the search box takes focus.
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (option) => {
    onValueChange?.(String(option.value));
    setOpen(false);
  };

  const move = (step) => {
    if (!filtered.length) return;
    let next = active;
    for (let i = 0; i < filtered.length; i += 1) {
      next = (next + step + filtered.length) % filtered.length;
      if (!filtered[next].disabled) break;
    }
    setActive(next);
  };

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(Math.max(0, filtered.length - 1)); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[active];
      if (option && !option.disabled) pick(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  const search = (
    <div className="relative border-b">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-controls={listId}
        aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-label={searchPlaceholder}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onKeyDown}
        placeholder={searchPlaceholder}
        className="h-11 w-full bg-transparent pr-3 pl-9 text-base outline-none placeholder:text-muted-foreground md:h-10 md:text-sm"
      />
    </div>
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      id={id}
      data-slot="searchable-select-trigger"
      disabled={disabled}
      role="combobox"
      aria-controls={open ? listId : undefined}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      aria-label={ariaLabel}
      // On a phone the sheet opens from here; on a desktop PopoverTrigger does it.
      onClick={isMobile ? () => setOpen(true) : undefined}
      className={cn(TRIGGER, className)}
    >
      <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground")}>{selected ? selected.label : placeholder}</span>
      <ChevronDownIcon className="size-4 shrink-0 opacity-50" aria-hidden="true" />
    </button>
  );

  const body = (
    <OptionList listId={listId} options={filtered} value={value} active={active} setActive={setActive} onPick={pick} emptyText={emptyText}
      className={isMobile ? "min-h-0 flex-1" : "max-h-[min(18rem,calc(var(--radix-popover-content-available-height,24rem)-3rem))]"} />
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="flex max-h-[85dvh] flex-col gap-0 rounded-t-xl p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            <SheetHeader className="border-b px-4 py-3 text-left">
              <SheetTitle className="text-base">{label || placeholder}</SheetTitle>
              <SheetDescription className="sr-only">Type to filter the list, then choose one.</SheetDescription>
            </SheetHeader>
            {search}
            <div className="flex min-h-[40dvh] flex-1 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">{body}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        collisionBoundary={boundary || undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex w-(--radix-popover-trigger-width) min-w-56 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0"
        data-slot="searchable-select-content"
      >
        {search}
        {body}
      </PopoverContent>
    </Popover>
  );
}
