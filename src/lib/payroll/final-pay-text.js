/**
 * How final pay reads on screen, on the payslip and in the PDF (2026-11-20):
 * pesos with ₱ and commas, dates and months in words, never ISO.
 * Pure: safe in the browser and on the server.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/** 14069.03 → "₱14,069.03" (negative → "-₱…"). */
export function pesoText(value) {
  const n = Number(value) || 0;
  const text = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}₱${text}`;
}

/** "2026-10" → "October 2026" (anything else unchanged). */
export function monthText(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(monthKey || "");
}

/** "2026-11-02" → "Nov 2, 2026". */
export function dateText(key) {
  if (!isKey(key)) return String(key || "");
  const [y, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

/** "2026-10-01".."2026-10-25" → "Oct 1–25, 2026"; across months "Oct 30 – Nov 10, 2026". */
export function rangeText(from, to) {
  if (!isKey(from) || !isKey(to)) return `${dateText(from)} – ${dateText(to)}`;
  if (from === to) return dateText(from);
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const short = (m) => MONTHS[m - 1].slice(0, 3);
  if (fy === ty && fm === tm) return `${short(fm)} ${fd}–${td}, ${fy}`;
  if (fy === ty) return `${short(fm)} ${fd} – ${short(tm)} ${td}, ${fy}`;
  return `${dateText(from)} – ${dateText(to)}`;
}

/** An ISO time → "Nov 19, 2026, 9:45 PM" (Manila). */
export function dateTimeText(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

/** A final pay line's label with its month in words: "SSS (October 2026)". */
export function lineLabel(label, monthKey) {
  return monthKey ? `${label} (${monthText(monthKey)})` : label;
}
