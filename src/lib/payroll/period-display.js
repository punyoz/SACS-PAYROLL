import { dayLabel } from "@/lib/date-label";

/**
 * A pay period as people read it (2026-11-26). Display only: the stored label stays the lookup key.
 *   "Final pay — separated 2026-10-21"  ->  "Final pay: separated Oct 21, 2026"
 * Every other label is returned unchanged.
 */
export function periodDisplay(label) {
  const text = String(label || "");
  const m = text.match(/^Final pay — separated (\d{4}-\d{2}-\d{2})$/);
  return m ? `Final pay: separated ${dayLabel(m[1])}` : text;
}
