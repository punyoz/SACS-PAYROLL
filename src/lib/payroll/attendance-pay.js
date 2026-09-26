/**
 * Attendance -> payroll: turns one employee's attendance records for a pay
 * period into deduction and incentive lines, each tied to the attendance log
 * it came from.
 *
 *   Late          every late_days_per_absent Late days = 1 absence
 *                 (absent_pct % of the daily rate); fewer in the period cost
 *                 nothing, and 0 turns the rule off. Optionally also
 *                 late_minute_charge_pct % of the hourly rate per late minute
 *                 (0 = off, the starting value). Both are Super Admin settings.
 *   Undertime     short minutes ÷ 60 × hourly rate
 *   Half Day      half_day_pct % of the daily rate
 *   Absent        absent_pct % of the daily rate (not on a day covered by
 *                 approved leave -- leave is paid or deducted on its own line)
 *   Early Bird    early_bird_bonus per Early Bird day
 *   Perfect       perfect_attendance_bonus when the period has no Late,
 *   Attendance    Undertime, Absent or Half Day and at least one day attended
 *
 * The minutes and flags are the ones the database engine stored on each row
 * (late_minutes, undertime_minutes, is_half_day, is_early_bird), so a status
 * label is never parsed to decide money. Rates are the versions in force on
 * the period's first day (src/lib/payroll/rates.js).
 *
 * Incomplete and Pending Correction records are never counted either way:
 * they are returned in `blocking`, and payroll refuses to process the
 * employee until they are resolved.
 */

import { isUnresolvedStatus, normalizeAttendanceStatus } from "@/lib/attendance/status";

/** Round to centavos. */
export function peso(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

const valueOf = (rates, type) => Number(rates?.[type]?.value ?? rates?.[type] ?? 0) || 0;
const configOf = (rates, type) => rates?.[type]?.config_id || null;

function dayKey(row) {
  return String(row.log_date || row.time_in || row.created_at || "").slice(0, 10);
}

/**
 * @param {object}   args
 * @param {Array}    args.logs         the employee's attendance rows (one per day)
 * @param {Set}      [args.leaveDays]  date keys covered by approved leave
 * @param {object}   args.rates        resolveRates() output (or { type: value })
 * @param {string}   args.periodStart  "YYYY-MM-DD"
 * @param {string}   args.periodEnd    "YYYY-MM-DD"
 */
export function computeAttendancePay({ logs, leaveDays, rates, periodStart, periodEnd }) {
  const hourly = valueOf(rates, "hourly");
  const daily = valueOf(rates, "daily");
  const halfDayAmount = peso(daily * valueOf(rates, "half_day_pct") / 100);
  const absentAmount = peso(daily * valueOf(rates, "absent_pct") / 100);
  const lateDaysPerAbsent = Math.max(0, Math.floor(valueOf(rates, "late_days_per_absent")));
  const lateMinutePct = valueOf(rates, "late_minute_charge_pct");
  const earlyBirdBonus = valueOf(rates, "early_bird_bonus");
  const perfectBonus = valueOf(rates, "perfect_attendance_bonus");

  const counts = {
    late_minutes: 0,
    undertime_minutes: 0,
    half_days: 0,
    absent_days: 0,
    early_bird_days: 0,
    attended_days: 0,
    late_days: 0,
    undertime_days: 0,
  };
  const deductions = [];
  const incentives = [];
  const blocking = [];
  const attendedLogIds = [];
  const lateLogs = [];

  const rows = (logs || [])
    .filter((row) => {
      const key = dayKey(row);
      return key && key >= periodStart && key <= periodEnd;
    })
    .sort((a, b) => dayKey(a).localeCompare(dayKey(b)));

  rows.forEach((row) => {
    const status = normalizeAttendanceStatus(row.status);
    const date = dayKey(row);
    const logId = row.id || null;
    const onLeave = Boolean(leaveDays?.has?.(date));

    if (isUnresolvedStatus(status)) {
      blocking.push({ log_id: logId, log_date: date, status });
      return;
    }

    if (status === "Absent") {
      // Approved leave already accounts for the day (paid, or deducted once
      // as Leave Without Pay) -- never also an absence.
      if (onLeave) return;
      counts.absent_days += 1;
      deductions.push({
        type: "absent", quantity: 1, unit: "day", rate: absentAmount,
        rate_config_id: configOf(rates, "absent_pct") || configOf(rates, "daily"),
        amount: absentAmount, source_log_id: logId, log_date: date,
      });
      return;
    }

    counts.attended_days += 1;
    if (logId) attendedLogIds.push(logId);

    if (row.is_half_day === true) {
      if (onLeave) return;
      counts.half_days += 1;
      deductions.push({
        type: "half_day", quantity: 1, unit: "day", rate: halfDayAmount,
        rate_config_id: configOf(rates, "half_day_pct") || configOf(rates, "daily"),
        amount: halfDayAmount, source_log_id: logId, log_date: date,
      });
      return;
    }

    // Late days are charged in groups (N late = 1 absent) after the loop;
    // the per-minute charge, when switched on, per day here.
    const lateMinutes = Math.max(0, Math.round(Number(row.late_minutes) || 0));
    if (lateMinutes > 0) {
      counts.late_minutes += lateMinutes;
      counts.late_days += 1;
      lateLogs.push({ logId, date });
      if (lateMinutePct > 0) {
        deductions.push({
          type: "late", quantity: lateMinutes, unit: "minute", rate: peso(hourly * lateMinutePct / 100),
          rate_config_id: configOf(rates, "late_minute_charge_pct"),
          amount: peso((lateMinutes / 60) * hourly * lateMinutePct / 100), source_log_id: logId, log_date: date,
          charge: "minute",
        });
      }
    }

    const undertimeMinutes = Math.max(0, Math.round(Number(row.undertime_minutes) || 0));
    if (undertimeMinutes > 0) {
      counts.undertime_minutes += undertimeMinutes;
      counts.undertime_days += 1;
      deductions.push({
        type: "undertime", quantity: undertimeMinutes, unit: "minute", rate: hourly,
        rate_config_id: configOf(rates, "hourly"),
        amount: peso((undertimeMinutes / 60) * hourly), source_log_id: logId, log_date: date,
      });
    }

    if (row.is_early_bird === true) {
      counts.early_bird_days += 1;
      if (earlyBirdBonus > 0) {
        incentives.push({
          type: "early_bird", quantity: 1, unit: "day", rate: earlyBirdBonus,
          rate_config_id: configOf(rates, "early_bird_bonus"),
          amount: peso(earlyBirdBonus), source_log_id: logId, log_date: date,
        });
      }
    }
  });

  // N late = 1 absent. Each group is one line, traced to all its logs
  // (source_log_id is the day that completed the group).
  if (lateDaysPerAbsent > 0) {
    for (let i = 0; i + lateDaysPerAbsent <= lateLogs.length; i += lateDaysPerAbsent) {
      const group = lateLogs.slice(i, i + lateDaysPerAbsent);
      const last = group[group.length - 1];
      deductions.push({
        type: "late", quantity: lateDaysPerAbsent, unit: "late day", rate: absentAmount,
        rate_config_id: configOf(rates, "late_days_per_absent"),
        amount: absentAmount, source_log_id: last.logId,
        source_log_ids: group.map((g) => g.logId).filter(Boolean), log_date: last.date,
        charge: "days",
      });
    }
  }

  const perfectAttendance = blocking.length === 0
    && counts.attended_days > 0
    && counts.absent_days === 0
    && counts.half_days === 0
    && counts.late_minutes === 0
    && counts.undertime_minutes === 0;

  if (perfectAttendance && perfectBonus > 0) {
    incentives.push({
      type: "perfect_attendance", quantity: 1, unit: "period", rate: perfectBonus,
      rate_config_id: configOf(rates, "perfect_attendance_bonus"),
      amount: peso(perfectBonus), source_log_id: null, source_log_ids: attendedLogIds, log_date: null,
    });
  }

  const sum = (lines, type) => peso(lines.filter((l) => l.type === type).reduce((s, l) => s + l.amount, 0));
  const lateBy = (charge) => peso(deductions.filter((l) => l.type === "late" && l.charge === charge).reduce((s, l) => s + l.amount, 0));

  return {
    counts,
    perfect_attendance: perfectAttendance,
    amounts: {
      late: sum(deductions, "late"),
      // The two parts of Late, so an override of the late-day count reprices
      // only the day rule.
      late_days_charge: lateBy("days"),
      late_minutes_charge: lateBy("minute"),
      undertime: sum(deductions, "undertime"),
      half_day: sum(deductions, "half_day"),
      absent: sum(deductions, "absent"),
      early_bird: sum(incentives, "early_bird"),
      perfect_attendance: sum(incentives, "perfect_attendance"),
    },
    unit_amounts: {
      hourly,
      daily,
      half_day: halfDayAmount,
      absent: absentAmount,
      late_days_per_absent: lateDaysPerAbsent,
      late_minute_pct: lateMinutePct,
      early_bird: peso(earlyBirdBonus),
      perfect_attendance: peso(perfectBonus),
    },
    deductions,
    incentives,
    blocking,
    source_log_ids: rows.map((row) => row.id).filter(Boolean),
  };
}
