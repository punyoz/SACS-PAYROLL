/**
 * Final pay for separated employees (docs/payroll-schedule-loans-awol.md
 * §5.4; src/lib/payroll/final-pay.js). Accountant (own branch) / Super Admin.
 *
 *   GET                       separated employees, with final pay status and
 *                             the 30-day deadline (DOLE Labor Advisory 06-2020)
 *   GET ?employee_id=…        the computed breakdown (nothing saved)
 *   POST { employee_id, release_on }
 *                             saves the final pay as a Final payslip through
 *                             payroll_commit_entries (loan repayments in the
 *                             same transaction), records the pro-rated 13th
 *                             month, settles the subsidy balance and stamps
 *                             the AWOL case
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { manilaDateKey } from "@/lib/payroll/periods";
import { roundPeso } from "@/lib/payroll/money";
import { loadRateConfigs, rateValues, resolveRate, resolveRates } from "@/lib/payroll/rates";
import { monthlyContributionsFor } from "@/lib/payroll/school-sheet";
import {
  dailyRateFor,
  monthInfo,
  monthlyWindow,
  resolveTaxTableRows,
  shiftMonth,
  taxTableFromRows,
  SEMI_MONTHLY_RULES_EFFECTIVE,
} from "@/lib/payroll/semi-monthly";
import { loadPayslipSchedule } from "@/lib/payroll/schedule";
import { basicEarnedFromPayroll } from "@/lib/payroll/thirteenth-month";
import { DEFAULT_BENEFITS_CEILING } from "@/lib/payroll/teacher-subsidy";
import { computeFinalPay, paidDaysBetween } from "@/lib/payroll/final-pay";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";

const peso = (value) => roundPeso(value);
const DEADLINE_DAYS = 30;
const finalPayLabel = (separatedOn) => `Final pay — separated ${separatedOn}`;

function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

function expandDays(from, to) {
  const days = [];
  if (!isDate(from) || !isDate(to)) return days;
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Everything computeFinalPay needs, read for one separated employee. */
async function gather(supabase, person) {
  const separatedOn = person.separated_on;
  const year = Number(String(separatedOn).slice(0, 4));
  const { configs } = await loadRateConfigs(supabase);
  const schedule = await loadPayslipSchedule(supabase);
  const lockDayFor = schedule ? schedule.lockDayFor
    : (monthKey) => Number(resolveRate(configs, "attendance_lock_day", {}, `${monthKey}-16`).value) || 0;

  const [profile, entriesResult, taxRows, holidaysResult, thirteenth, balanceResult, loansResult, benefitsResult] = await Promise.all([
    supabase.from("profiles").select("basic_salary,position").eq("id", person.id).maybeSingle(),
    supabase.from("payroll_entries").select("id,pay_period,status,payroll").eq("employee_id", person.id).eq("status", "paid"),
    supabase.from("payroll_tax_brackets").select("version_id,effective_date,bracket_over,base_tax,rate_pct,created_at").lte("effective_date", separatedOn),
    supabase.from("attendance_holidays").select("holiday_date,day_part"),
    supabase.from("payroll_thirteenth_month").select("id").eq("employee_id", person.id).eq("year", year).maybeSingle(),
    supabase.from("payroll_subsidy_balances").select("*").eq("employee_id", person.id).lte("subsidy_year_start", separatedOn).gte("subsidy_year_end", separatedOn).maybeSingle(),
    supabase.from("payroll_loans").select("*").eq("employee_id", person.id),
    supabase.from("payroll_exempt_benefits_paid").select("amount").eq("employee_id", person.id).eq("tax_year", year),
  ]);
  if (entriesResult.error) throw new Error(entriesResult.error.message);

  const salary = peso(profile.data?.basic_salary || 0);
  const rates = rateValues(resolveRates(configs, { employeeId: person.id, branchId: person.branch_id, position: profile.data?.position }, separatedOn));
  const daily = dailyRateFor(salary, rates.working_days_per_year);
  const entries = entriesResult.data || [];
  const paidLabels = new Set(entries.map((e) => e.pay_period));

  // Unsettled months: back from the separation month to the first month whose
  // 2nd half is Final (and never before the semi-monthly rules).
  const sepMonth = String(separatedOn).slice(0, 7);
  const months = [];
  let m = sepMonth;
  while (m >= SEMI_MONTHLY_RULES_EFFECTIVE.slice(0, 7) && !paidLabels.has(monthInfo(m).second_half_label)) {
    months.unshift(m);
    m = shiftMonth(m, -1);
  }
  // The separation can fall after the separation month's window (it then belongs to next month's).
  const windows = months.map((key) => ({ key, window: monthlyWindow(key, lockDayFor) }));
  const lastWindow = windows[windows.length - 1]?.window;
  if (lastWindow && lastWindow.end_key < separatedOn) {
    const next = shiftMonth(sepMonth, 1);
    windows.push({ key: next, window: monthlyWindow(next, lockDayFor) });
  }

  const earliest = windows[0]?.window.start_key || separatedOn;
  const [logs, leaves] = await Promise.all([
    supabase.from("attendance_logs").select("log_date,status").eq("employee_id", person.id).gte("log_date", earliest).lte("log_date", separatedOn),
    supabase.from("leave_requests").select("start_date,end_date,status,pay_status").eq("employee_id", person.id),
  ]);
  const absent = new Set((logs.data || []).filter((l) => l.status === "Absent").map((l) => String(l.log_date).slice(0, 10)));
  const unpaidLeave = new Set((leaves.data || [])
    .filter((l) => String(l.status).toLowerCase() === "approved" && String(l.pay_status || "").toLowerCase().includes("without"))
    .flatMap((l) => expandDays(String(l.start_date).slice(0, 10), String(l.end_date).slice(0, 10))));
  const holidays = new Set((holidaysResult.data || []).filter((h) => (h.day_part || "whole") === "whole").map((h) => String(h.holiday_date).slice(0, 10)));

  const monthInputs = windows.map(({ key, window }) => {
    const info = monthInfo(key);
    const firstHalf = entries.find((e) => e.pay_period === info.first_half_label);
    const firstHalfPaid = firstHalf ? peso(firstHalf.payroll?.totals?.net_pay || 0) : 0;
    const to = window.end_key < separatedOn ? window.end_key : separatedOn;
    const inWindow = (d) => d >= window.start_key && d <= to;
    const absentDays = [...absent].filter(inWindow).length + [...unpaidLeave].filter((d) => inWindow(d) && !absent.has(d)).length;
    const partial = window.end_key >= separatedOn
      ? paidDaysBetween({ from: window.start_key, to: separatedOn, absent, unpaidLeave, holidays })
      : null;
    return { month_key: key, window, absent_days: absentDays, first_half_paid: firstHalfPaid, ...(partial ? { partial } : {}) };
  }).filter((month) => month.window.start_key <= separatedOn);

  const basicEarnedYtd = peso(entries
    .filter((e) => String(e.pay_period).endsWith(String(year)))
    .reduce((sum, e) => sum + basicEarnedFromPayroll(e.payroll), 0));

  // The subsidy year's balance, by the rule for this kind of separation.
  let subsidy = null;
  const balance = balanceResult.data;
  if (balance && ["open", "paid_out"].includes(balance.status)) {
    const dismissed = /awol|abandon|cause|dismiss/i.test(String(person.separation_reason || ""));
    const [ey, em] = String(balance.eligible_from).split("-").map(Number);
    const [sy, sm, sd] = String(separatedOn).split("-").map(Number);
    const monthsEarned = Math.max(0, Math.min(balance.eligible_months, (sy * 12 + sm) - (ey * 12 + em) + (sd >= 15 ? 1 : 0)));
    subsidy = {
      balance_id: balance.id, rule: dismissed ? balance.on_dismissal : balance.on_resignation,
      annual_amount: Number(balance.annual_amount), months_earned: monthsEarned, proration: balance.proration,
      advances_total: Number(balance.advances_total) + Number(balance.carried_in || 0), paid_out: Number(balance.paid_out || 0),
      tax_treatment: balance.tax_treatment,
    };
  }

  // Carry-over owed by the last Final 2nd half.
  const lastSecond = entries.filter((e) => /\s16-\d{2},/.test(e.pay_period)).sort((a, b) => String(b.pay_period).localeCompare(String(a.pay_period)))[0];
  const carryIn = peso(lastSecond?.payroll?.monthly?.carry_over_out || 0);

  const loans = (loansResult.data || []).filter((loan) => loan.status !== "paid" && Number(loan.remaining_balance) > 0
    && (!loan.awaiting_decision || (loan.decision === "final_pay" && loan.decision_approved_at)));
  const ceilingRate = resolveRate(configs, "benefits_exempt_ceiling", {}, separatedOn);

  return {
    salary, daily, rates,
    input: {
      monthlySalary: salary, dailyRate: daily, separatedOn, months: monthInputs,
      contributions: monthlyContributionsFor(salary, rates),
      taxTable: taxTableFromRows(resolveTaxTableRows(taxRows.data || [], separatedOn)),
      basicEarnedYtd, thirteenthPaid: Boolean(thirteenth.data), subsidy,
      benefitsYtd: peso((benefitsResult.data || []).reduce((s, r) => s + Number(r.amount || 0), 0)),
      ceiling: ceilingRate.source === "config" ? Number(ceilingRate.value) : DEFAULT_BENEFITS_CEILING,
      carryIn, loans,
    },
    year,
  };
}

async function separatedPeople(supabase, guard) {
  const staff = await loadPayrollStaff(supabase, guard, { includeArchived: true });
  return staff.filter((p) => p.employee_status === "Separated" && p.separated_on);
}

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "read");
    if (guard.denied) return guard.denied;
    const supabase = getAdminClient();
    const people = await separatedPeople(supabase, guard);
    const url = new URL(request.url);
    const employeeId = normalizeText(url.searchParams.get("employee_id"));
    const today = manilaDateKey();

    if (employeeId) {
      const person = people.find((p) => p.id === employeeId);
      if (!person) return NextResponse.json({ error: "Separated employee not found in your branch." }, { status: 404 });
      const { input, salary, daily } = await gather(supabase, person);
      const breakdown = computeFinalPay(input);
      return NextResponse.json({ person: { id: person.id, full_name: person.full_name, employee_id: person.employee_id, separated_on: person.separated_on }, salary, daily, breakdown });
    }

    const saved = people.length
      ? await supabase.from("payroll_entries").select("employee_id,pay_period,payslip_no,payroll,status").in("employee_id", people.map((p) => p.id)).like("pay_period", "Final pay%")
      : { data: [] };
    return NextResponse.json({
      people: people.map((p) => {
        const entry = (saved.data || []).find((e) => e.employee_id === p.id);
        const deadline = addDays(p.separated_on, DEADLINE_DAYS);
        return {
          id: p.id, full_name: p.full_name, employee_id: p.employee_id, separated_on: p.separated_on,
          deadline, days_left: Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000),
          final_pay: entry ? { payslip_no: entry.payslip_no, net_pay: entry.payroll?.totals?.net_pay ?? null, release_on: entry.payroll?.final_pay?.release_on || null } : null,
        };
      }),
      can_edit: guard.role === "accountant" || guard.role === "super_admin",
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "create");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const people = await separatedPeople(supabase, guard);
    const person = people.find((p) => p.id === normalizeText(body.employee_id));
    if (!person) return NextResponse.json({ error: "Separated employee not found in your branch." }, { status: 404 });
    if (person.id === guard.userId) return NextResponse.json({ error: "You cannot process your own final pay." }, { status: 403 });
    const releaseOn = normalizeText(body.release_on, manilaDateKey());
    if (!isDate(releaseOn) || releaseOn < person.separated_on) return NextResponse.json({ error: "Choose the release date (on or after the separation)." }, { status: 400 });

    const label = finalPayLabel(person.separated_on);
    const existing = await supabase.from("payroll_entries").select("id").eq("employee_id", person.id).eq("pay_period", label).eq("status", "paid").maybeSingle();
    if (existing.data) return NextResponse.json({ error: "This final pay is already saved." }, { status: 409 });

    const { input, year } = await gather(supabase, person);
    const fp = computeFinalPay(input);
    const now = new Date().toISOString();
    const entryId = crypto.randomUUID();
    const payroll = {
      basic_salary: input.monthlySalary,
      basic_earned: fp.basic_earned,
      final_pay: { separated_on: person.separated_on, release_on: releaseOn, breakdown: fp, computed_by_name: actorName(guard) },
      totals: { gross_pay: fp.gross, total_deductions: fp.total_deductions, total_incentives: 0, net_pay: fp.net_pay },
    };
    const item = {
      record: {
        employee_id: person.id, employee_name: person.full_name, employee_type: person.employee_type,
        gross_pay: fp.gross, total_deductions: fp.total_deductions, net_pay: fp.net_pay, period_label: label,
        processed_at: now, base_pay: input.monthlySalary, total_incentives: 0,
        period_start: input.months[0]?.window.start_key || person.separated_on, period_end: person.separated_on,
        processed_by: guard.userId || null, processed_by_name: actorName(guard),
      },
      entry: { id: entryId, employee_id: person.id, employee_name: person.full_name, employee_code: person.employee_id, employee_type: person.employee_type,
        position: person.position || null, pay_period: label, status: "paid", payroll, submitted_at: now, created_at: now, updated_at: now },
      deductions: fp.deductions.filter((d) => ["sss", "philhealth", "pagibig", "withholding_tax", "carry_over", "loan"].includes(d.kind))
        .map((d) => ({ type: d.kind, quantity: null, unit: null, rate: null, amount: d.amount, is_override: true, note: d.note || `Final pay${d.month_key ? ` (${d.month_key})` : ""}` })),
      incentives: [],
      loan_payments: fp.loan_payments,
    };
    const { data, error } = await supabase.rpc("payroll_commit_entries", { p_items: [item] });
    if (error) throw new Error(error.message);
    const result = Array.isArray(data) ? data[0] : null;
    if (!result?.ok) return NextResponse.json({ error: `Final pay was not saved: ${result?.error || "the database refused it."}` }, { status: 400 });

    // After the commit: the 13th month is paid, the subsidy year settled, loans
    // the final pay could not cover referred for collection, the case stamped.
    if (fp.thirteenth_month > 0) {
      await supabase.from("payroll_thirteenth_month").insert({
        employee_id: person.id, employee_name: person.full_name, year, basic_earned: peso(input.basicEarnedYtd + fp.basic_earned),
        amount: fp.thirteenth_month, breakdown: { final_pay: true }, processed_by: guard.userId || null, processed_by_name: actorName(guard),
      });
    }
    if (fp.subsidy?.balance_id) {
      await supabase.from("payroll_subsidy_balances").update({
        paid_out: fp.subsidy.payout, paid_out_on: releaseOn, forfeited: fp.subsidy.forfeited, status: "settled_in_final_pay",
        payout_entry_id: result.entry_id, status_reason: `Final pay ${label}`, updated_at: now,
      }).eq("id", fp.subsidy.balance_id);
    }
    for (const left of fp.uncovered) {
      await supabase.from("payroll_loans").update({
        status: "suspended", status_reason: `Separated – for collection (${left.reason})`, status_changed_by: guard.userId || null,
        status_changed_by_name: actorName(guard), status_changed_at: now,
      }).eq("id", left.loan_id);
    }
    await supabase.from("employee_awol_cases").update({ final_pay_computed_at: now, final_pay_released_on: releaseOn, updated_at: now })
      .eq("employee_id", person.id).eq("outcome", "separated");

    await appendAuditLog({
      actor: guard, module: "payroll", action: "final_pay", entity_type: "payroll_entry", entity_id: result.entry_id, status: "success", source: "api",
      description: `Final pay for ${personLabel(person)} (separated ${person.separated_on}): net ${fp.net_pay.toFixed(2)}, released ${releaseOn}${fp.uncovered.length ? `; ${fp.uncovered.length} loan balance(s) referred for collection` : ""}.`,
      metadata: { payslip_no: result.payslip_no, net_pay: fp.net_pay, release_on: releaseOn },
    });
    return NextResponse.json({ success: true, payslip_no: result.payslip_no, net_pay: fp.net_pay });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
