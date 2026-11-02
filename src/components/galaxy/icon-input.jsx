import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/**
 * Text box with a leading icon; green border and gold glow when focused,
 * dashed and grey when read-only.
 * Design from Uiverse.io by RashadGhzi ("stupid-firefox-88"), MIT license.
 * Recoloured with the theme tokens in src/styles/ui.css.
 */

/** Focus and read-only states, appended to every Input (src/components/ui/input.jsx). */
export const galaxyInputStates =
  "focus-visible:border-primary focus-visible:ring-ring/45 [&[readonly]]:cursor-not-allowed [&[readonly]]:border-dashed [&[readonly]]:bg-muted [&[readonly]]:text-muted-foreground";

/** An Input with an icon at the start. Every prop goes to the Input unchanged. */
export function IconInput({ icon: Icon, className, ...props }) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gold-text" aria-hidden="true" />
      <Input className={cn("pl-9", className)} {...props} />
    </div>
  );
}
