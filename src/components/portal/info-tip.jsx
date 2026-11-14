"use client";

import { InfoIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * An ⓘ button that opens a short explanation. A popover, not a hover tooltip,
 * so it works with the keyboard (Tab + Enter) and on phones (tap).
 */
export function InfoTip({ children, label = "More information", className, side = "top" }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} data-testid="info-tip"
          // -my-1: the 20px tap target does not make its label row taller than its neighbours (fields stay aligned).
          className={cn("-my-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full align-middle text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", className)}>
          <InfoIcon className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} className="w-72 text-xs leading-relaxed font-normal tracking-normal normal-case">{children}</PopoverContent>
    </Popover>
  );
}
