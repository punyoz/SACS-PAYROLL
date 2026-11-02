"use client";

/*
 * Rolling-digit number, adapted from "AnimatedNumber" by Ashutoshx7
 * (VengeanceUI, https://github.com/Ashutoshx7/VengeanceUI, MIT License).
 * Rebuilt in CSS (the v-digit-strip utility in src/styles/ui.css) instead of
 * Framer Motion. The digits are generated content and a screen-reader copy
 * holds the real value, so the element's text is unchanged for tests and
 * assistive technology. Honors prefers-reduced-motion.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export function AnimatedNumber({ value, className }) {
  const text = String(value);
  // First paint shows zeros, then each column rolls to its digit.
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <span className={cn("relative inline-flex align-top", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex items-start">
        {[...text].map((ch, i) => (/\d/.test(ch) ? (
          <span key={i} className="inline-block h-[1lh] overflow-hidden">
            <span className="v-digit-strip" style={{ "--v-digit": shown ? ch : 0 }} />
          </span>
        ) : (
          <span key={i} data-char={ch} className="h-[1lh] whitespace-pre before:content-[attr(data-char)]" />
        )))}
      </span>
    </span>
  );
}
