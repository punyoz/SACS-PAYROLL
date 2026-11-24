/**
 * Dates as people read them (2026-11-24): "Oct 7, 2026"; a range "Nov 12 – 13, 2026" (same month),
 * "Oct 30 – Nov 2, 2026" (same year). Never an ISO date in a message someone reads.
 */
const fmt = (key, opts) => new Date(`${String(key).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

export function dayLabel(key) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(key || ""))) return String(key || "");
  return fmt(key, { month: "short", day: "numeric", year: "numeric" });
}

export function rangeLabel(from, to) {
  const a = String(from || "").slice(0, 10), b = String(to || from || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return String(from || "");
  if (!b || a === b) return dayLabel(a);
  if (a.slice(0, 7) === b.slice(0, 7)) return `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { day: "numeric" })}, ${a.slice(0, 4)}`;
  if (a.slice(0, 4) === b.slice(0, 4)) return `${fmt(a, { month: "short", day: "numeric" })} – ${fmt(b, { month: "short", day: "numeric" })}, ${a.slice(0, 4)}`;
  return `${dayLabel(a)} – ${dayLabel(b)}`;
}
