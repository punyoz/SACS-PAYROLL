/**
 * Substitute teaching by school employees: the rules, from the schedule and the taps only (no timetable).
 * Pure functions; the settings are pending the school's policy manual.
 *
 * A substitution: { id, sub_date, start_time "HH:MM", end_time, periods, absent_name, class_section?, subject? }
 *
 * Pay (2026-11-26, school policy; replaces the ₱150-a-period allowance and the inside / outside / overload
 * split, from Nov 16-30 on; earlier payslips keep their lines): OVERTIME,
 *   periods covered × period length (setting, 1 h) × the substitute's hourly rate × the overtime rate
 *   (regular day 125%; a holiday: the holiday rate × 130%; a rest day: the rest-day premium, 130% — 2026-11-26).
 * The HR-approved substitution is the authorization (no overtime request). The substitute's taps must cover
 * the class time; without them it is not paid and HR is told. Never paid twice: minutes an approved overtime
 * request already covers are left out of the substitution line (and flagged). Substitution hours do not count
 * toward the overtime caps unless the setting says so (off).
 */

import { attendanceSpanOf } from "@/lib/payroll/final-payslips";

export const SUBSTITUTION_SETTINGS = {
  substitution_period_hours: { label: "Length of a class period (hours)", min: 0.25, max: 4, fallback: 1 },
  substitution_counts_toward_ot_cap: { label: "Substitution hours count toward the overtime caps", options: ["off", "on"], fallback: "off" },
  substitution_cap_periods_week: { label: "Substitution periods a week per teacher (cap)", min: 1, max: 40, fallback: 5 },
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const minutesOf = (hhmm) => {
  const m = TIME.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pesoText = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const hoursText = (min) => { const h = Math.floor(min / 60); const m = min % 60; return `${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""}` || "0 h"; };
const dayLabel = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The Monday (UTC date key) of the week a date key falls in. */
export function weekOf(key) {
  const d = new Date(`${key}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 864e5).toISOString().slice(0, 10);
}

/** Minutes of [a, b) that fall inside [s, e). */
const overlap = (a, b, s, e) => Math.max(0, Math.min(b, e) - Math.max(a, s));

/**
 * Whether the substitute's taps cover the substitution: a time in at or
 * before its start (within the grace) and a time out at or after its end.
 *   log: { time_in, time_out } (ISO, Manila-local minutes computed by the caller)
 */
export function tapsConfirm(sub, tapMinutes, graceMinutes = 15) {
  const start = minutesOf(sub.start_time);
  const end = minutesOf(sub.end_time);
  if (!tapMinutes || tapMinutes.in === null || tapMinutes.in === undefined || tapMinutes.out === null || tapMinutes.out === undefined) return false;
  return tapMinutes.in <= start + graceMinutes && tapMinutes.out >= end;
}

/**
 * Earnings lines for one employee's substitutions in a period (paid as overtime).
 *   subs            approved substitutions (any order)
 *   tapsOf(date)    → { in, out } minutes, or null
 *   dayKindOf(date) → "regular" | "rest_day" | "holiday" | "special"
 *   overtimeOf(date) → [[start, end], …] minutes of approved overtime requests that day
 *   rates           { hourly, overtime_regular_pct (125), regular_holiday_premium_pct, special_holiday_premium_pct }
 *   settings        readSubstitutionSettings()
 * → { lines: [...], unconfirmed: [{ id, sub_date }], overlaps: [{ id, sub_date, minutes }] }
 */
export function computeSubstitutionPay({ subs, tapsOf, dayKindOf = () => "regular", overtimeOf = () => [], rates, settings }) {
  const hourly = Number(rates.hourly) || 0;
  const regularPct = Number(rates.overtime_regular_pct) || 125;
  const pctOf = (kind) => (kind === "holiday" ? Math.round((100 + (Number(rates.regular_holiday_premium_pct) || 0)) * 1.3)
    : kind === "special" ? Math.round((100 + (Number(rates.special_holiday_premium_pct) || 0)) * 1.3)
    // 2026-11-26: a rest day (not a holiday) pays the rest-day premium (Labor Code: 130 %).
    : kind === "rest_day" ? 100 + (rates.rest_day_premium_pct == null ? 30 : Number(rates.rest_day_premium_pct) || 0) : regularPct);
  const periodHours = Number(settings?.substitution_period_hours) || 1;
  const lines = [];
  const unconfirmed = [];
  const overlaps = [];
  const sorted = [...(subs || [])].sort((a, b) => `${a.sub_date} ${a.start_time}`.localeCompare(`${b.sub_date} ${b.start_time}`));
  for (const sub of sorted) {
    const start = minutesOf(sub.start_time);
    const end = minutesOf(sub.end_time);
    if (start === null || end === null || end <= start) continue;
    if (!tapsConfirm(sub, tapsOf(sub.sub_date))) { unconfirmed.push({ id: sub.id, sub_date: sub.sub_date }); continue; }
    const periods = Math.max(1, Math.round(Number(sub.periods) || 1));
    let minutes = Math.round(periods * periodHours * 60);
    // Never paid twice: the class time an approved overtime request already pays is left out.
    const paidAsOvertime = (overtimeOf(sub.sub_date) || []).reduce((sum, [s0, e0]) => sum + overlap(start, end, s0, e0), 0);
    if (paidAsOvertime > 0) {
      overlaps.push({ id: sub.id, sub_date: sub.sub_date, minutes: Math.min(paidAsOvertime, minutes) });
      minutes = Math.max(0, minutes - paidAsOvertime);
    }
    if (!minutes) continue;
    const pct = pctOf(dayKindOf(sub.sub_date));
    const amount = peso(hourly * minutes / 60 * pct / 100);
    const who = `covering ${sub.absent_name || "a teacher"}${sub.class_section ? `, ${sub.class_section}` : ""}${sub.subject ? ` (${sub.subject})` : ""} (${dayLabel(sub.sub_date)})`;
    lines.push({ type: "substitution", kind: "overtime_substitution", source_id: sub.id, log_date: sub.sub_date, minutes, rate_pct: pct, amount,
      note: `Overtime (substitution): ${hoursText(minutes)} × ${pesoText(peso(hourly))} × ${pct}%, ${who}${paidAsOvertime > 0 ? " (overlapping overtime paid once)" : ""}` });
  }
  return { lines, unconfirmed, overlaps };
}

/** The settings in effect (system_config section "substitution"; a missing or bad value → its default). */
export async function readSubstitutionSettings(supabase) {
  const out = Object.fromEntries(Object.entries(SUBSTITUTION_SETTINGS).map(([k, d]) => [k, d.fallback]));
  try {
    const { data } = await supabase.from("system_config").select("key,value").eq("section", "substitution");
    for (const row of data || []) {
      const def = SUBSTITUTION_SETTINGS[row.key];
      if (!def) continue;
      if (def.options) { if (def.options.includes(row.value)) out[row.key] = row.value; continue; }
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= def.min && n <= def.max) out[row.key] = n;
    }
  } catch { /* defaults */ }
  return out;
}

/**
 * Suggested substitutes (Part C): same branch and level, Teaching, tapped in
 * that day, not on approved leave, under the weekly cap. The Admin picks.
 *   people   [{ id, full_name, branch_id, employee_level, employee_type }]
 *   tapped   Set of ids with a time in that day
 *   onLeave  Set of ids on approved leave that day
 *   weekPeriods Map id → substitution periods already that week (open + approved)
 */
export function suggestSubstitutes({ absent, people, tapped, onLeave, weekPeriods, periods, cap }) {
  return (people || [])
    .filter((p) => p.id !== absent.id && String(p.branch_id || "") === String(absent.branch_id || "")
      && String(p.employee_type || "Teaching").toLowerCase() === "teaching"
      && String(p.employee_level || "") === String(absent.employee_level || "")
      && tapped.has(p.id) && !onLeave.has(p.id)
      && (weekPeriods.get(p.id) || 0) + periods <= cap)
    .map((p) => ({ id: p.id, full_name: p.full_name, week_periods: weekPeriods.get(p.id) || 0 }))
    .sort((a, b) => a.week_periods - b.week_periods || a.full_name.localeCompare(b.full_name));
}

/**
 * Approved substitutions whose own cutoff was already processed (a non-draft
 * payslip covers the date) without them: the next payslip pays them.
 */
export function lateSubstitutions(subs, entries) {
  const out = new Set();
  for (const r of subs) {
    const date = String(r.sub_date).slice(0, 10);
    const covering = entries.filter((e) => String(e.employee_id) === String(r.substitute_id) && (() => { const span = attendanceSpanOf(e); return span && date >= span.start_key && date <= span.end_key; })());
    if (!covering.length) continue; // not processed yet: its own payslip pays it
    const paid = covering.some((e) => (e.payroll?.audit?.lines?.incentives || []).some((l) => l.type === "substitution" && String(l.substitution_id) === String(r.id)));
    if (!paid) out.add(r.id);
  }
  return out;
}
