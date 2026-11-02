/*
 * Rising-bars loader, adapted from "RevealLoader" by Ashutoshx7 (VengeanceUI,
 * https://github.com/Ashutoshx7/VengeanceUI, MIT License). The full-screen
 * GSAP splash is reduced to its staggered bars, in the theme's green and gold.
 * aria-busy keeps the e2e settle() helper waiting while it shows.
 */

import { cn } from "@/lib/utils";

const BARS = [0, 1, 2, 3, 4];

export function BarsLoader({ label = "Loading", showLabel = false, className }) {
  return (
    <span role="status" aria-busy="true" className={cn("inline-flex items-center gap-3", className)}>
      <span className="flex h-7 items-end gap-1" aria-hidden="true">
        {BARS.map((i) => (
          <span
            key={i}
            className={cn("h-full w-1.5 origin-bottom animate-v-bars rounded-full motion-reduce:animate-none", i % 2 ? "bg-brand-gold" : "bg-primary")}
            style={{ animationDelay: `${i * 0.1}s` }}
          />
        ))}
      </span>
      <span className={showLabel ? "text-sm text-muted-foreground" : "sr-only"}>{label}</span>
    </span>
  );
}
