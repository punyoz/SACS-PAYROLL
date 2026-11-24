/** The defense's daily taps (src/app/api/cron/demo-taps): the minutes of one person's taps on one day. */
import { createHash } from "node:crypto";

/** A stable 0..n-1 from a text (the same person and day give the same minute). */
const pick = (text, n) => parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16) % n;
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The day's taps for one person: [in, out] in minutes after midnight (Manila). Pure. */
export function dayTaps({ id, day, start, end, half = null }) {
  const mid = Math.round((start + end) / 2);
  const late = pick(`${id}${day}late`, 20) === 0;
  let tin = late ? start + 12 + pick(`${id}${day}lm`, 29) : start - (5 + pick(`${id}${day}in`, 21));
  let tout = end + pick(`${id}${day}out`, 21);
  if (half === "AM") tin = mid - (3 + pick(`${id}${day}h`, 8));
  if (half === "PM") tout = mid + pick(`${id}${day}h`, 6);
  return [tin, tout];
}

