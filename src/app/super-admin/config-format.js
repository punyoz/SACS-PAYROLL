/*
 * Display helpers for System Configuration (saRateDisplay, saRateDate,
 * saPeso, saTaxFor, saHolidayDate in public/legacy/js/super-admin.js).
 */

/** A rate's value in its unit: "2%", "3 late = 1 absent", "₱100.00"… */
export function rateDisplay(rate, value) {
  const amount = Number(value || 0);
  const unit = rate?.unit;
  if (unit === "percent") return `${amount.toLocaleString("en-PH", { maximumFractionDigits: 2 })}%`;
  if (unit === "count") return amount > 0 ? `${amount} late = 1 absent` : "Off";
  if (unit === "day_of_month") return amount > 0 ? `Day ${amount}` : "Month end";
  if (unit === "days") return `${amount} days`;
  if (unit === "switch") return amount === 1 ? "On" : "Off";
  if (unit === "half") return ({ 1: "1–15 payslip", 2: "16–end payslip", 3: "Half on each" })[amount] || String(amount);
  return `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Oct 7, 2026" for a "YYYY-MM-DD" key, in Manila. */
export function rateDate(key) {
  if (!key) return "";
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** "Wed, Oct 7, 2026" for a holiday. */
export function holidayDate(key) {
  const date = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function peso(value) {
  return `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Tax on a taxable income with the brackets being edited. */
export function taxFor(taxable, rows) {
  const sorted = [...rows].sort((a, b) => Number(a.bracket_over) - Number(b.bracket_over));
  let bracket = sorted[0];
  sorted.forEach((row) => { if (taxable > Number(row.bracket_over)) bracket = row; });
  if (!bracket) return 0;
  return Math.max(0, Math.round((Number(bracket.base_tax) + (taxable - Number(bracket.bracket_over)) * Number(bracket.rate_pct) / 100) * 100) / 100);
}

/** Today in Manila as "YYYY-MM-DD". */
export function manilaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

/**
 * A rate's versions, oldest first: { text, range, who, note, now }.
 * "₱100.00 (Jan 1, 2026 – Sep 25, 2026) → ₱110.00 (Sep 26, 2026 – present)"
 */
export function rateHistory(rate, history, today) {
  return (history || []).map((version) => ({
    key: `${version.effective_date}-${version.value}`,
    text: rateDisplay(rate, version.value),
    range: `${rateDate(version.effective_date)} – ${version.until ? rateDate(version.until) : (version.effective_date > today ? "onward" : "present")}`,
    who: version.created_by_name || "",
    note: version.note || "",
    now: version.effective_date <= today && (!version.until || version.until >= today),
  }));
}
