/**
 * Overtime requests (Part B, 2026-11-22): the limits and the checks, in plain
 * words. The limits are settings (system_config, section "requests"; the
 * defaults are pending the school's policy manual). The server runs
 * checkOvertimeRequest() before anything is saved; the table
 * (20261122010000) keeps one open request per employee and day.
 */

import { periodForDateKey } from "@/lib/payroll/periods";

export const REQUEST_SETTINGS = {
  overtime_max_hours_day: { label: "Overtime limit a day (hours)", min: 1, max: 12, fallback: 3 },
  overtime_max_hours_cutoff: { label: "Overtime limit a cutoff (hours)", min: 1, max: 80, fallback: 10 },
  file_days_before: { label: "File at least this many days before", min: 0, max: 14, fallback: 1 },
  late_filing_days_after: { label: "Late filing allowed up to this many days after", min: 0, max: 14, fallback: 2 },
  // Labor Code Art. 87: at least 125% of the hourly rate on an ordinary working day.
  // Rest days and holidays keep the rate table (payroll_rate_configs).
  overtime_regular_pct: { label: "Overtime pay on a regular working day (% of the hourly rate)", min: 125, max: 300, fallback: 125 },
};

/** The settings in effect (a missing or bad value falls back to its default). */
export async function readRequestSettings(supabase) {
  const out = Object.fromEntries(Object.entries(REQUEST_SETTINGS).map(([key, def]) => [key, def.fallback]));
  try {
    const { data } = await supabase.from("system_config").select("key,value").eq("section", "requests");
    for (const row of data || []) {
      const def = REQUEST_SETTINGS[row.key];
      const n = Number(row.value);
      if (def && Number.isFinite(n) && n >= def.min && n <= def.max) out[row.key] = n;
    }
  } catch { /* defaults */ }
  return out;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => {
  const m = TIME.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const dayNumber = (key) => Math.round(Date.parse(`${key}T00:00:00Z`) / 86400000);
const hoursText = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""}` || "0 h";
};
export { hoursText };

/**
 * { error } or { minutes, late_filing, period_label }.
 *   input:    { request_date, planned_start "HH:MM", planned_end "HH:MM", reason }
 *   today:    Manila date key
 *   settings: readRequestSettings()
 *   open:     the employee's pending/approved requests ({ request_date, minutes })
 *   refusal:  the pay-rule refusal (eligibilityRefusal "overtime"), or null
 */
export function checkOvertimeRequest(input, { today, settings, open = [], refusal = null }) {
  const date = String(input?.request_date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { error: "Choose the date of the overtime." };
  const start = minutesOf(input.planned_start);
  const end = minutesOf(input.planned_end);
  if (start === null || end === null) return { error: "Enter the planned start and end times (HH:MM)." };
  if (end <= start) return { error: "The planned end must be after the planned start (overtime past midnight is filed as two days)." };
  const minutes = end - start;
  const reason = String(input.reason || "").trim();
  if (reason.length < 3) return { error: "Say what the overtime is for (at least 3 characters)." };
  if (reason.length > 500) return { error: "The reason is too long (500 characters at most)." };
  if (refusal) return { error: refusal };

  const maxDay = settings.overtime_max_hours_day * 60;
  if (minutes > maxDay) return { error: `Overtime is at most ${hoursText(maxDay)} a day. This request is ${hoursText(minutes)}.` };

  const days = dayNumber(date) - dayNumber(today);
  let late = false;
  if (days < settings.file_days_before) {
    if (days < -settings.late_filing_days_after) {
      return { error: `Overtime is filed at least ${settings.file_days_before} day${settings.file_days_before === 1 ? "" : "s"} before, or up to ${settings.late_filing_days_after} day${settings.late_filing_days_after === 1 ? "" : "s"} after as a late filing. ${date} is past that.` };
    }
    late = true;
  }

  if (open.some((r) => r.request_date === date)) return { error: `You already have an overtime request for ${date}. Cancel it first to file a different one.` };
  const period = periodForDateKey(date);
  const inCutoff = open.filter((r) => r.request_date >= period.start_key && r.request_date <= period.end_key).reduce((sum, r) => sum + (Number(r.minutes) || 0), 0);
  const maxCutoff = settings.overtime_max_hours_cutoff * 60;
  if (inCutoff + minutes > maxCutoff) {
    return { error: `This would make ${hoursText(inCutoff + minutes)} of overtime in ${period.label}; the limit is ${hoursText(maxCutoff)} a cutoff (${hoursText(Math.max(0, maxCutoff - inCutoff))} left).` };
  }
  return { minutes, late_filing: late, period_label: period.label, cutoff_minutes_after: inCutoff + minutes };
}

/**
 * "Approved 2 h, worked 1 h 15 min → 1 h 15 min paid" (the paid minutes are
 * the smaller); a pending request reads "Requested …, … if approved".
 */
export function overtimePaidText(approvedMinutes, workedMinutes, { pending = false } = {}) {
  const asked = `${pending ? "Requested" : "Approved"} ${hoursText(approvedMinutes)}`;
  if (workedMinutes === null || workedMinutes === undefined) return `${asked}; paid after the time-out tap${pending ? " if approved" : ""}`;
  const paid = Math.min(approvedMinutes, Math.max(0, workedMinutes));
  return `${asked}, worked ${hoursText(Math.max(0, workedMinutes))} → ${hoursText(paid)} paid${pending ? " if approved" : ""}`;
}
