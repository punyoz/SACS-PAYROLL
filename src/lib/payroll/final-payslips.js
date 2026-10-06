/**
 * Final payslips and the attendance they were computed from.
 *
 * A Final payslip is locked: correcting attendance afterwards changes the
 * attendance record but not the payslip, which only a Super Admin override
 * recomputes. Nothing said so, so a corrected day could go unpaid (or stay
 * deducted) without anyone noticing. These helpers find:
 *
 *   - the Final payslips whose attendance includes a given day, so whoever
 *     approves a correction is told the payslip needs an override;
 *   - the Final payslips whose attendance changed after they were finalized
 *     (public.attendance_logs_history), so the Super Admin's Final Payslip
 *     Override list can mark them.
 *
 * Which days a payslip counted: a semi-monthly 16-end payslip reads its
 * attendance window (payroll.monthly.window, e.g. the 16th of last month to
 * the 15th); a 1-15 payslip that settles nothing reads none; any other
 * payslip reads its own pay period.
 */

import { periodFromLabel } from "@/lib/payroll/periods";

function payrollOf(entry) {
  const payroll = entry?.payroll;
  if (typeof payroll === "string") {
    try { return JSON.parse(payroll); } catch { return null; }
  }
  return payroll || null;
}

/** { start_key, end_key } of the attendance a Final payslip counted, or null. */
export function attendanceSpanOf(entry) {
  const payroll = payrollOf(entry);
  const monthly = payroll?.monthly || null;
  if (monthly?.half === "first") return null;
  if (monthly?.window?.start_key && monthly?.window?.end_key) {
    return { start_key: monthly.window.start_key, end_key: monthly.window.end_key };
  }
  const period = payroll?.audit?.period;
  if (period?.start_key && period?.end_key) return { start_key: period.start_key, end_key: period.end_key };
  const fromLabel = periodFromLabel(entry?.pay_period);
  return fromLabel ? { start_key: fromLabel.start_key, end_key: fromLabel.end_key } : null;
}

/** When the payslip became Final (its latest generation or override). */
export function finalizedAtOf(entry) {
  const payroll = payrollOf(entry);
  return String(payroll?.generation?.generated_at || entry?.submitted_at || entry?.updated_at || "");
}

const isFinal = (entry) => String(entry?.status || "").toLowerCase() === "paid";

/** The employee's Final payslips whose attendance includes `dateKey`. */
export async function finalPayslipsCovering(supabase, employeeId, dateKey) {
  if (!employeeId || !dateKey) return [];
  try {
    const result = await supabase
      .from("payroll_entries")
      .select("id,employee_id,pay_period,status,payslip_no,payroll,submitted_at,updated_at")
      .eq("employee_id", employeeId)
      .eq("status", "paid")
      .limit(500);
    if (result.error) return [];
    return (result.data || []).filter((entry) => {
      const span = attendanceSpanOf(entry);
      return span && dateKey >= span.start_key && dateKey <= span.end_key;
    }).map((entry) => ({ entry_id: entry.id, pay_period: entry.pay_period, payslip_no: entry.payslip_no || null }));
  } catch {
    return [];
  }
}

/** The message shown after a correction on a day a Final payslip counted, or null. */
export function finalPayslipNotice(payslips) {
  if (!payslips?.length) return null;
  const names = payslips.map((p) => `${p.pay_period}${p.payslip_no ? ` (${p.payslip_no})` : ""}`).join(", ");
  return `This day is on a Final payslip: ${names}. The payslip does not change by itself; ask a Super Admin to override it so the correction is paid.`;
}

/** Same, looked up for one employee and day. */
export async function correctionPayrollNotice(supabase, employeeId, dateKey) {
  return finalPayslipNotice(await finalPayslipsCovering(supabase, employeeId, dateKey));
}

function changed(row) {
  return String(row.old_time_in || "") !== String(row.new_time_in || "")
    || String(row.old_time_out || "") !== String(row.new_time_out || "")
    || String(row.old_status || "") !== String(row.new_status || "")
    || String(row.old_log_date || "") !== String(row.new_log_date || "");
}

/**
 * Attendance changes made after each Final payslip was finalized, on days it
 * counted: Map of entry id -> { count, latest_at, days }. Entries with none
 * are absent from the map. An unreadable history gives an empty map.
 */
export async function attendanceChangesAfterFinal(supabase, entries) {
  const finals = (entries || []).filter(isFinal).map((entry) => ({
    entry,
    span: attendanceSpanOf(entry),
    finalizedAt: finalizedAtOf(entry),
  })).filter((item) => item.span && item.finalizedAt);
  const out = new Map();
  if (!finals.length) return out;

  const employeeIds = [...new Set(finals.map((item) => String(item.entry.employee_id)))];
  const time = (value) => Date.parse(String(value || "")) || 0;
  const since = new Date(Math.min(...finals.map((item) => time(item.finalizedAt)))).toISOString();
  try {
    const result = await supabase
      .from("attendance_logs_history")
      .select("employee_id,changed_at,old_log_date,new_log_date,old_time_in,new_time_in,old_time_out,new_time_out,old_status,new_status")
      .in("employee_id", employeeIds.slice(0, 500))
      .gte("changed_at", since)
      .limit(5000);
    if (result.error) return out;
    const history = (result.data || []).filter(changed);

    finals.forEach(({ entry, span, finalizedAt }) => {
      const hits = history.filter((row) => {
        if (String(row.employee_id) !== String(entry.employee_id)) return false;
        if (time(row.changed_at) <= time(finalizedAt)) return false;
        const day = String(row.new_log_date || row.old_log_date || "").slice(0, 10);
        return day >= span.start_key && day <= span.end_key;
      });
      if (!hits.length) return;
      out.set(entry.id, {
        count: hits.length,
        latest_at: new Date(Math.max(...hits.map((row) => time(row.changed_at)))).toISOString(),
        days: [...new Set(hits.map((row) => String(row.new_log_date || row.old_log_date).slice(0, 10)))].sort(),
      });
    });
  } catch {
    return out;
  }
  return out;
}
