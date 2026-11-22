/**
 * Substitute teaching by school employees (Part C, 2026-11-22): the rules,
 * from the schedule and the taps only (no timetable). Pure functions; the
 * settings are pending the school's policy manual.
 *
 * A substitution: { id, sub_date, start_time "HH:MM", end_time, periods,
 *   absent_name, class_section?, subject? }
 *
 * Pay, per substitution confirmed by the substitute's taps:
 *   - the part inside the substitute's own shift: the substitution allowance
 *     (fixed ₱ per period, default ₱150; or own hourly × hours; or a % of it);
 *   - the part outside the shift: overtime rules (Part B: 125% of hourly);
 *     the approved substitution is the authorization;
 *   - hours above the weekly standard load (scheduled hours + approved
 *     substitutions that week, a setting) are paid at the overload rate
 *     instead. Never paid twice: each hour is in exactly one of the three.
 */

import { attendanceSpanOf } from "@/lib/payroll/final-payslips";

export const SUBSTITUTION_SETTINGS = {
  substitution_rate_mode: { label: "Allowance inside the shift", options: ["fixed", "hourly", "pct"], fallback: "fixed" },
  substitution_fixed_per_period: { label: "Allowance per class period (₱)", min: 0, max: 5000, fallback: 150 },
  substitution_pct: { label: "Allowance as % of own hourly rate", min: 0, max: 300, fallback: 100 },
  substitution_cap_periods_week: { label: "Substitution periods a week per teacher (cap)", min: 1, max: 40, fallback: 5 },
  standard_load_hours_week: { label: "Standard weekly load (hours) before overload", min: 1, max: 80, fallback: 40 },
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
 * Earnings lines for one employee's substitutions in a period.
 *   subs            approved substitutions (any order)
 *   shiftOf(date)   → { start, end } minutes of the substitute's own shift that day, or null (rest day)
 *   tapsOf(date)    → { in, out } minutes, or null
 *   scheduledHoursOfWeek(weekKey) → the substitute's scheduled hours that week
 *   rates           { hourly, overload_premium_pct, overtime_regular_pct }
 *   settings        readSubstitutionSettings()
 * → { lines: [...], unconfirmed: [{ id, sub_date }] }
 */
export function computeSubstitutionPay({ subs, shiftOf, tapsOf, scheduledHoursOfWeek, rates, settings }) {
  const hourly = Number(rates.hourly) || 0;
  const overloadRate = hourly * (1 + (Number(rates.overload_premium_pct) || 0) / 100);
  const overtimeRate = hourly * (Number(rates.overtime_regular_pct) || 125) / 100;
  const standardMin = Number(settings.standard_load_hours_week) * 60;
  const used = new Map(); // week → minutes counted so far (scheduled + substitutions)
  const lines = [];
  const unconfirmed = [];
  const sorted = [...(subs || [])].sort((a, b) => `${a.sub_date} ${a.start_time}`.localeCompare(`${b.sub_date} ${b.start_time}`));

  for (const sub of sorted) {
    const start = minutesOf(sub.start_time);
    const end = minutesOf(sub.end_time);
    if (start === null || end === null || end <= start) continue;
    if (!tapsConfirm(sub, tapsOf(sub.sub_date))) { unconfirmed.push({ id: sub.id, sub_date: sub.sub_date }); continue; }
    const total = end - start;
    const week = weekOf(sub.sub_date);
    if (!used.has(week)) used.set(week, Math.round((Number(scheduledHoursOfWeek(week)) || 0) * 60));
    const before = used.get(week);
    const overloadMin = Math.min(total, Math.max(0, before + total - standardMin));
    used.set(week, before + total);
    const regularMin = total - overloadMin;
    // Of the regular part, what lies inside the substitute's own shift that day (a vacant period) — the
    // earliest minutes of the class are counted first, the overload part is its last minutes.
    const shift = shiftOf(sub.sub_date);
    const insideMin = shift ? Math.min(regularMin, overlap(start, start + regularMin, shift.start, shift.end)) : 0;
    const outsideMin = regularMin - insideMin;
    const periods = Math.max(1, Math.round(Number(sub.periods) || 1));
    const who = `covering ${sub.absent_name || "a teacher"}${sub.class_section ? `, ${sub.class_section}` : ""}${sub.subject ? ` (${sub.subject})` : ""} (${dayLabel(sub.sub_date)})`;

    if (insideMin > 0) {
      const share = insideMin / total;
      const mode = settings.substitution_rate_mode;
      let amount; let how;
      if (mode === "hourly") { amount = hourly * insideMin / 60; how = `${hoursText(insideMin)} × ${pesoText(hourly)}`; }
      else if (mode === "pct") { amount = hourly * Number(settings.substitution_pct) / 100 * insideMin / 60; how = `${hoursText(insideMin)} × ${settings.substitution_pct}% of ${pesoText(hourly)}`; }
      else {
        const p = Math.round(periods * share * 100) / 100;
        amount = Number(settings.substitution_fixed_per_period) * p;
        how = `${p} period${p === 1 ? "" : "s"} × ${pesoText(settings.substitution_fixed_per_period)}`;
      }
      lines.push({ type: "substitution", kind: "allowance", source_id: sub.id, log_date: sub.sub_date, minutes: insideMin, amount: peso(amount), note: `Substitution: ${how}, ${who}` });
    }
    if (outsideMin > 0) {
      lines.push({ type: "substitution", kind: "overtime", source_id: sub.id, log_date: sub.sub_date, minutes: outsideMin, amount: peso(overtimeRate * outsideMin / 60),
        note: `Substitution outside the shift: ${hoursText(outsideMin)} × ${pesoText(peso(overtimeRate))} (${Number(rates.overtime_regular_pct) || 125}% of hourly), ${who}` });
    }
    if (overloadMin > 0) {
      lines.push({ type: "substitution", kind: "overload", source_id: sub.id, log_date: sub.sub_date, minutes: overloadMin, amount: peso(overloadRate * overloadMin / 60),
        note: `Substitution above the standard load: ${hoursText(overloadMin)} × ${pesoText(peso(overloadRate))} (overload rate), ${who}` });
    }
  }
  return { lines, unconfirmed };
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
