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
export const LEAVE_CONVERSION_KEYS = Object.freeze({ enabled: "leave_conversion_enabled", maxDays: "leave_conversion_max_days" });

/** { enabled, max_days } from system_config rows (any section's rows may be passed). */
export function leaveConversionFrom(rows) {
  const value = (key) => (rows || []).find((r) => r.section === LEAVE_CONVERSION_SECTION && r.key === key)?.value;
  const enabled = String(value(LEAVE_CONVERSION_KEYS.enabled) || "").toLowerCase() === "true";
  const max = Number(value(LEAVE_CONVERSION_KEYS.maxDays));
  return { enabled, max_days: Number.isInteger(max) && max > 0 ? max : null };
}

/** The current setting. Never throws: off when it cannot be read. */
export async function loadLeaveConversion(supabase) {
  try {
    const result = await supabase.from("system_config").select("section,key,value")
      .eq("section", LEAVE_CONVERSION_SECTION).in("key", Object.values(LEAVE_CONVERSION_KEYS));
    return result.error ? { enabled: false, max_days: null } : leaveConversionFrom(result.data);
  } catch {
    return { enabled: false, max_days: null };
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
