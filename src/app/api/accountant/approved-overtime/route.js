/**
 * Approved overtime & substitutions (2026-11-26), read-only, for the Accountant's Attendance Records: what HR
 * approved and what the payslips paid for it. Sources: HR-approved overtime requests and HR-approved
 * substitutions (paid as overtime). No Admin endorsement anywhere.
 *
 *   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD   (default: the last 62 days)
 *     { rows: [{ kind, employee_id, employee_name, date, hours, rate, amount, pay_period, entry_id, detail }] }
 *
 * process_payroll read; an Accountant sees their own branch.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { manilaDateKey } from "@/lib/payroll/periods";
import { dayLabel } from "@/lib/date-label";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const minutesOf = (t) => { const [h, m] = String(t || "").split(":").map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : 0; };

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "read");
    if (guard.denied) return guard.denied;
    const url = new URL(request.url);
    const today = manilaDateKey();
    const to = DATE.test(url.searchParams.get("to") || "") ? url.searchParams.get("to") : today;
    const from = DATE.test(url.searchParams.get("from") || "") ? url.searchParams.get("from")
      : new Date(Date.parse(`${to}T00:00:00Z`) - 62 * 864e5).toISOString().slice(0, 10);
    const supabase = getServiceClient();
    let ot = supabase.from("overtime_requests").select("id,employee_id,branch_id,request_date,planned_start,planned_end,minutes,reason,decided_by_name")
      .eq("status", "approved").gte("request_date", from).lte("request_date", to);
    let subs = supabase.from("substitutions").select("id,branch_id,sub_date,start_time,end_time,periods,class_section,subject,absent_employee_id,substitute_id,decided_by_name")
      .eq("status", "approved").gte("sub_date", from).lte("sub_date", to).not("substitute_id", "is", null);
    if (!guard.branchExempt) { ot = ot.eq("branch_id", guard.branchId || ""); subs = subs.eq("branch_id", guard.branchId || ""); }
    const [{ data: otRows, error: e1 }, { data: subRows, error: e2 }] = await Promise.all([ot, subs]);
    if (e1 || e2) throw new Error((e1 || e2).message);

    const people = [...new Set([...(otRows || []).map((r) => r.employee_id), ...(subRows || []).flatMap((r) => [r.substitute_id, r.absent_employee_id])].filter(Boolean))];
    const [{ data: names }, { data: entries }, { data: allLines }, { data: logs }] = await Promise.all([
      fetchAllIn(() => supabase.from("profiles").select("id,full_name"), "id", people),
      fetchAllIn(() => supabase.from("payroll_entries").select("id,employee_id,pay_period,status,run_id,payroll"), "employee_id", people),
      fetchAllIn(() => supabase.from("payroll_incentives").select("employee_id,pay_period,type,amount,rate,quantity,note,source_log_id,payroll_record_id").in("type", ["overtime", "substitution"]), "employee_id", people),
      fetchAllIn(() => supabase.from("attendance_logs").select("id,employee_id,log_date").gte("log_date", from).lte("log_date", to), "employee_id", people),
    ]);
    // Only the current payslips' lines (2026-11-25): a recomputed payslip archives its old record, and
    // the old record's lines stay in payroll_incentives; counting them showed the pay twice.
    const recordIds = [...new Set((allLines || []).map((l) => l.payroll_record_id).filter(Boolean))];
    const { data: archivedRecords, error: e3 } = recordIds.length
      ? await fetchAllIn(() => supabase.from("payroll_records").select("id").eq("archived", true), "id", recordIds)
      : { data: [] };
    if (e3) throw new Error(e3.message);
    const archived = new Set((archivedRecords || []).map((r) => r.id));
    const lines = (allLines || []).filter((l) => !l.payroll_record_id || !archived.has(l.payroll_record_id));
    const nameOf = new Map((names || []).map((p) => [p.id, p.full_name]));
    const logIdOf = new Map((logs || []).map((l) => [`${l.employee_id}|${String(l.log_date).slice(0, 10)}`, l.id]));
    // The payslip whose attendance window holds the date (its own audit span; else the label's half).
    const entryFor = (employeeId, date) => (entries || []).find((e) => {
      if (e.employee_id !== employeeId) return false;
      const w = e.payroll?.monthly?.window || e.payroll?.audit?.period || null;
      const start = w?.start_key || null, end = w?.end_key || null;
      if (start && end) return date >= start && date <= end;
      return false;
    }) || null;

    const rows = [];
    for (const r of otRows || []) {
      const date = String(r.request_date).slice(0, 10);
      const e = entryFor(r.employee_id, date);
      const logId = logIdOf.get(`${r.employee_id}|${date}`);
      const paid = (lines || []).filter((l) => l.employee_id === r.employee_id && l.type === "overtime" && logId && l.source_log_id === logId);
      rows.push({
        kind: "Overtime", employee_id: r.employee_id, employee_name: nameOf.get(r.employee_id) || "Employee", date, date_label: dayLabel(date),
        hours: Math.round(((Number(r.minutes) || (minutesOf(r.planned_end) - minutesOf(r.planned_start))) / 60) * 100) / 100,
        rate: paid[0] ? Number(paid[0].rate) : null, amount: paid.length ? Math.round(paid.reduce((s, l) => s + Number(l.amount || 0), 0) * 100) / 100 : null,
        pay_period: paid[0]?.pay_period || e?.pay_period || null, entry_id: e?.id || null,
        detail: `${String(r.planned_start).slice(0, 5)}–${String(r.planned_end).slice(0, 5)} · ${r.reason || ""}${r.decided_by_name ? ` · approved by ${r.decided_by_name}` : ""}`,
      });
    }
    for (const r of subRows || []) {
      const date = String(r.sub_date).slice(0, 10);
      const e = entryFor(r.substitute_id, date);
      const label = dayLabel(date).replace(/, \d{4}$/, "");
      const paid = (lines || []).filter((l) => l.employee_id === r.substitute_id && l.type === "substitution" && String(l.note || "").includes(`(${label})`));
      rows.push({
        kind: "Substitution (overtime)", employee_id: r.substitute_id, employee_name: nameOf.get(r.substitute_id) || "Substitute", date, date_label: dayLabel(date),
        hours: paid.length ? Math.round(paid.reduce((s, l) => s + Number(l.quantity || 0), 0) * 100) / 100 : Number(r.periods) || 1,
        rate: paid[0] ? Number(paid[0].rate) : null, amount: paid.length ? Math.round(paid.reduce((s, l) => s + Number(l.amount || 0), 0) * 100) / 100 : null,
        pay_period: paid[0]?.pay_period || e?.pay_period || null, entry_id: e?.id || null,
        detail: `Covering ${nameOf.get(r.absent_employee_id) || "a teacher"}${r.class_section ? `, ${r.class_section}` : ""} · ${r.periods || 1} period${Number(r.periods) === 1 ? "" : "s"}${r.decided_by_name ? ` · approved by ${r.decided_by_name}` : ""}`,
      });
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || a.employee_name.localeCompare(b.employee_name));
    return NextResponse.json({ rows, from, to });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
