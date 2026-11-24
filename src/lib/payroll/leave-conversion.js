/**
 * Unused leave conversion in final pay (decision 2026-11-09 #1).
 *
 * OFF until the school confirms its rule. HR or the Super Admin switches it
 * on (PATCH /api/payroll/leave-conversion), optionally with a maximum number
 * of days. When on, the final payslip pays min(unused leave-with-pay days,
 * max days) × the daily rate as its own income line ('leave_conversion').
 * Withholding tax on that line is NOT computed: its tax treatment is an open
 * decision for the school.
 *
 * Stored in system_config, section "payroll":
 *   leave_conversion_enabled   "true" | "false" (missing = false)
 *   leave_conversion_max_days  "" (no cap) | whole number 1–365
 */
export const LEAVE_CONVERSION_SECTION = "payroll";
export const LEAVE_CONVERSION_KEYS = Object.freeze({ enabled: "leave_conversion_enabled", maxDays: "leave_conversion_max_days",
  // 2026-11-26: de minimis days a year (excess taxable) and the statuses converted (empty = all on payroll).
  taxFreeDays: "leave_conversion_tax_free_days", statuses: "leave_conversion_statuses" });
export const LEAVE_CONVERSION_TAX_FREE_DAYS = 10;
export const LEAVE_CONVERSION_NOTE = "Pending the policy manual. Tax: de minimis up to 10 days a year, any excess taxable; verify with the school's accountant.";

/** { enabled, max_days } from system_config rows (any section's rows may be passed). */
export function leaveConversionFrom(rows) {
  const value = (key) => (rows || []).find((r) => r.section === LEAVE_CONVERSION_SECTION && r.key === key)?.value;
  const enabled = String(value(LEAVE_CONVERSION_KEYS.enabled) || "").toLowerCase() === "true";
  const max = Number(value(LEAVE_CONVERSION_KEYS.maxDays));
  const free = value(LEAVE_CONVERSION_KEYS.taxFreeDays);
  let statuses = [];
  try { statuses = JSON.parse(value(LEAVE_CONVERSION_KEYS.statuses) || "[]"); } catch { statuses = []; }
  return {
    enabled, max_days: Number.isInteger(max) && max > 0 ? max : null,
    tax_free_days: free === undefined || free === null || free === "" || !Number.isFinite(Number(free)) ? LEAVE_CONVERSION_TAX_FREE_DAYS : Math.max(0, Number(free)),
    statuses: Array.isArray(statuses) ? statuses.filter(Boolean) : [],
  };
}

/** The current setting. Never throws: off when it cannot be read. */
export async function loadLeaveConversion(supabase) {
  try {
    const result = await supabase.from("system_config").select("section,key,value")
      .eq("section", LEAVE_CONVERSION_SECTION).in("key", Object.values(LEAVE_CONVERSION_KEYS));
    return result.error ? leaveConversionFrom([]) : leaveConversionFrom(result.data);
  } catch {
    return leaveConversionFrom([]);
  }
}

/** Why a requested setting cannot be saved, or null. */
export function leaveConversionError({ enabled, max_days: maxDays }) {
  if (typeof enabled !== "boolean") return "Choose on or off.";
  if (maxDays !== null && maxDays !== undefined && maxDays !== "" && (!Number.isInteger(Number(maxDays)) || Number(maxDays) < 1 || Number(maxDays) > 365)) {
    return "Maximum days: a whole number from 1 to 365, or blank for no limit.";
  }
  return null;
}

/** The days paid and the amount, for this setting. */
export function leaveConversionAmount(setting, unusedDays, dailyRate) {
  const days = Math.max(0, Number(unusedDays) || 0);
  const paidDays = setting?.enabled ? (setting.max_days ? Math.min(days, setting.max_days) : days) : 0;
  const amount = Math.round(paidDays * (Number(dailyRate) || 0) * 100) / 100;
  return { paid_days: paidDays, amount };
}

// ── Year-end conversion, tax split and preview (2026-11-26) ─────────────────────────────────────────────
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const peso = (n) => `₱${cents(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysText = (d) => `${d} unused day${d === 1 ? "" : "s"}`;

/** The conversion's daily rate: monthly × 12 ÷ 261 (the payroll divisor), to the centavo. */
export function conversionDailyRate(monthlySalary, divisor = 261) {
  return cents((Number(monthlySalary) || 0) * 12 / (Number(divisor) || 261));
}

/**
 * One employee: { eligible, reason, days, daily_rate, amount, exempt_days, exempt, taxable, note }. `remaining`
 * is the pool's unused days (approved leave only; a pending request is not used); half days count 0.5.
 * The same function makes the December line, the final pay and the preview, so they never differ.
 */
export function leaveConversionFor({ setting, remaining, monthlySalary, status = "", divisor = 261 }) {
  const s = setting || leaveConversionFrom([]);
  const daily = conversionDailyRate(monthlySalary, divisor);
  const none = (reason) => ({ eligible: false, reason, days: 0, daily_rate: daily, amount: 0, exempt_days: 0, exempt: 0, taxable: 0, note: "" });
  if (!s.enabled) return none("Leave conversion is off.");
  if ((s.statuses || []).length && !s.statuses.includes(status)) return none(`Not converted for ${status || "this status"}.`);
  let days = Math.max(0, Math.floor((Number(remaining) || 0) * 2) / 2);
  if (s.max_days) days = Math.min(days, s.max_days);
  const amount = cents(days * daily);
  const exemptDays = Math.min(days, Number(s.tax_free_days ?? LEAVE_CONVERSION_TAX_FREE_DAYS) || 0);
  const exempt = Math.min(amount, cents(exemptDays * daily));
  return {
    eligible: true, reason: days ? "" : "No unused days.", days, daily_rate: daily, amount, exempt_days: exemptDays, exempt, taxable: cents(amount - exempt),
    note: days ? `Leave conversion: ${daysText(days)} × ${peso(daily)} = ${peso(amount)}` : "",
  };
}

/** The payslip that carries the year-end conversion: the Dec 16–31 half. */
export function isYearEndPeriod(startKey) {
  return /^\d{4}-12-16$/.test(String(startKey || ""));
}

/** "If the year ended today: 3 unused days → ₱4,413.78 (paid on the Dec 16–31 payslip)". */
export function conversionPreviewText(c) {
  if (!c || !c.eligible) return c?.reason || "";
  if (!c.days) return "If the year ended today: no unused days to convert.";
  return `If the year ended today: ${daysText(c.days)} → ${peso(c.amount)} (paid on the Dec 16–31 payslip)`;
}
