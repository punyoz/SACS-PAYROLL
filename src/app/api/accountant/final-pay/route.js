/**
 * Final pay for separated employees (docs/payroll-schedule-loans-awol.md
 * §5.4; src/lib/payroll/final-pay.js). Accountant (own branch) / Super Admin.
 *
 *   GET                       separated employees, with final pay status and
 *                             the 30-day deadline (DOLE Labor Advisory 06-2020)
 *   GET ?employee_id=…        the computed breakdown (nothing saved)
 *   POST { employee_id, release_on, correction? }
 *                             Accountant only: submits the final pay for HR
 *                             approval (20261120010000). Saved "Pending HR
 *                             Approval" with the full computed payslip and its
 *                             side effects; the loans, 13th month and subsidy
 *                             it uses are held. HR's approval
 *                             (src/app/api/hr/final-pay-approvals) writes the
 *                             Final payslip, repayments, 13th month, subsidy
 *                             settlement and AWOL stamp in one transaction.
 *                             correction: true recomputes an approved final
 *                             pay as a correction (same approval).
 *
 * Year-end tax (2026-10-29, src/lib/payroll/year-end-tax.js): when the
 * Accountant has run the annualization for the separation year, the final pay
 * settles it: tax due on the year (the final pay included) less everything
 * withheld, as its own "Year-end tax adjustment" line (a refund is a credit).
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
import { loadSssMscRows, mscTableOn } from "@/lib/payroll/sss-msc";
import { loadSalaryChanges, salaryOn } from "@/lib/employees/salary-history";
import { isApproved } from "@/lib/payroll/adjustment-approvals";
import {
  monthInfo,
  monthlyWindow,
  resolveTaxTableRows,
  shiftMonth,
  taxTableFromRows,
  SEMI_MONTHLY_RULES_EFFECTIVE,
} from "@/lib/payroll/semi-monthly";
import { loadPayslipSchedule } from "@/lib/payroll/schedule";
import { basicEarnedFromPayroll } from "@/lib/payroll/thirteenth-month";
import { hrAccountIds, notify } from "@/lib/branch-requests-server";
import { DEFAULT_BENEFITS_CEILING } from "@/lib/payroll/teacher-subsidy";
import { computeFinalPay, finalPayDailyRate, paidDaysBetween } from "@/lib/payroll/final-pay";
import { actorName, loadPayrollStaff, personLabel } from "@/lib/payroll/staff";
import { fetchAllIn } from "@/lib/supabase/fetch-all";
import { payslipFigures } from "@/lib/payroll/bir-2316";
import { loadBirYear } from "@/lib/payroll/bir-forms";
import { applyYearEndToFinalPay, yearEndAdjustment } from "@/lib/payroll/year-end-tax";
import { holidayAppliesTo, isDayOff, shapeHolidayRow } from "@/lib/attendance/holidays";
import { leaveBalances } from "@/lib/employees/classification-server";
import { leaveConversionAmount, loadLeaveConversion } from "@/lib/payroll/leave-conversion";
import { LEGACY_LABEL, SUBMISSIONS, deadlineOf, shapeSubmission } from "@/lib/payroll/final-pay-approval";

const peso = (value) => roundPeso(value);
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
async function gather(supabase, person, correcting = null) {
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
    supabase.from("attendance_holidays").select("holiday_date,day_part,type,branch_ids"),
    supabase.from("payroll_thirteenth_month").select("id,breakdown").eq("employee_id", person.id).eq("year", year).maybeSingle(),
    supabase.from("payroll_subsidy_balances").select("*").eq("employee_id", person.id).lte("subsidy_year_start", separatedOn).gte("subsidy_year_end", separatedOn).maybeSingle(),
    supabase.from("payroll_loans").select("*").eq("employee_id", person.id),
    supabase.from("payroll_exempt_benefits_paid").select("amount").eq("employee_id", person.id).eq("tax_year", year),
  ]);
  if (entriesResult.error) throw new Error(entriesResult.error.message);
  // A correction is computed as if the approved final pay had not been applied.
  if (correcting) {
    if (thirteenth.data?.breakdown?.final_pay) thirteenth.data = null;
    const b = balanceResult.data;
    if (b && b.payout_entry_id === correcting.entry_id) {
      if (!correcting.subsidy_before) throw Object.assign(new Error("This final pay settled a subsidy before HR approval was required, so it cannot be recomputed here. Ask the Super Admin."), { status: 409 });
      balanceResult.data = { ...b, ...correcting.subsidy_before };
    }
    const paid = await supabase.from("payroll_loan_payments").select("loan_id,amount").eq("payroll_entry_id", correcting.entry_id).in("kind", ["final_pay", "subsidy_offset"]).eq("reversed", false);
    for (const p of paid.data || []) {
      const loan = (loansResult.data || []).find((l) => l.id === p.loan_id);
      if (loan) Object.assign(loan, { remaining_balance: peso(Number(loan.remaining_balance) + Number(p.amount)), status: loan.status === "paid" ? "active" : loan.status });
    }
  }

  // The salary in force on the last day (HR's salary changes, 2026-10-26).
  const salary = peso(salaryOn((await loadSalaryChanges(supabase, [person.id])).rows, person.id, separatedOn, profile.data?.basic_salary || 0));
  const rates = rateValues(resolveRates(configs, { employeeId: person.id, branchId: person.branch_id, position: profile.data?.position, monthlySalary: salary }, separatedOn));
  // Same rule as regular payroll (2026-11-08): an employee's own daily rate wins.
  const daily = finalPayDailyRate(rates);
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
  const holidays = new Set((holidaysResult.data || []).filter((h) => isDayOff(shapeHolidayRow(h)) && holidayAppliesTo(h, person.branch_id)).map((h) => String(h.holiday_date).slice(0, 10)));

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
    // The 1st half's basic is already in basicEarnedYtd; the 13th month counts it once.
    const firstHalfBasic = firstHalf ? basicEarnedFromPayroll(firstHalf.payroll) : 0;
    return { month_key: key, window, absent_days: absentDays, first_half_paid: firstHalfPaid, first_half_basic: firstHalfBasic, ...(partial ? { partial } : {}) };
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
      // As it stands before this final pay: put back if HR rejects (nothing is written until then).
      before: { status: balance.status, paid_out: balance.paid_out, paid_out_on: balance.paid_out_on, forfeited: balance.forfeited, payout_entry_id: balance.payout_entry_id, status_reason: balance.status_reason },
      balance_id: balance.id, rule: dismissed ? balance.on_dismissal : balance.on_resignation,
      annual_amount: Number(balance.annual_amount), months_earned: monthsEarned, proration: balance.proration,
      advances_total: Number(balance.advances_total) + Number(balance.carried_in || 0), paid_out: Number(balance.paid_out || 0),
      tax_treatment: balance.tax_treatment,
    };
  }

  // Carry-over owed by the last Final 2nd half.
  const lastSecond = entries.filter((e) => /\s16-\d{2},/.test(e.pay_period)).sort((a, b) => String(b.pay_period).localeCompare(String(a.pay_period)))[0];
  const carryIn = peso(lastSecond?.payroll?.monthly?.carry_over_out || 0);

  // Only loans HR approved (20261027020000).
  const loans = (loansResult.data || []).filter((loan) => isApproved(loan) && loan.status !== "paid" && Number(loan.remaining_balance) > 0
    && (!loan.awaiting_decision || (loan.decision === "final_pay" && loan.decision_approved_at)));
  const ceilingRate = resolveRate(configs, "benefits_exempt_ceiling", {}, separatedOn);

  return {
    salary, daily, rates,
    input: {
      monthlySalary: salary, dailyRate: daily, separatedOn, months: monthInputs,
      contributions: monthlyContributionsFor(salary, rates, {}, { mscTable: mscTableOn((await loadSssMscRows(supabase)).rows, separatedOn) }),
      taxTable: taxTableFromRows(resolveTaxTableRows(taxRows.data || [], separatedOn)),
      basicEarnedYtd, thirteenthPaid: Boolean(thirteenth.data), subsidy,
      benefitsYtd: peso((benefitsResult.data || []).reduce((s, r) => s + Number(r.amount || 0), 0)),
      ceiling: ceilingRate.source === "config" ? Number(ceilingRate.value) : DEFAULT_BENEFITS_CEILING,
      carryIn, loans,
    },
    year,
  };
}

/**
 * The annualization of the separation year, if the Accountant ran one, and
 * the year without this final pay (null: none run, or 20261029010000 not applied).
 */
async function pendingYearEndTax(supabase, person, year) {
  const found = await supabase.from("payroll_tax_annualizations").select("id,tax_year,status").eq("employee_id", person.id).eq("tax_year", year).maybeSingle();
  if (found.error || !found.data) return null;
  const data = await loadBirYear(supabase, {
    year, employeeIds: [person.id], approvedOnly: false, excludePeriod: finalPayLabel(person.separated_on), details: false,
  });
  const row = data.rows[0];
  return {
    record: found.data,
    prior: row?.sources || { payslips: [], benefits: [], adjustments: [] },
    employee: row?.employee || { separated_on: person.separated_on },
    ceiling: data.ceiling,
    taxTable: data.tax_table,
  };
}

/** Settle the pending year-end tax on the final pay breakdown (mutates it). */
function settleYearEndTax(fp, pending, { year, releaseOn, input }) {
  if (!pending) return null;
  const treatment = input.subsidy?.tax_treatment || null;
  const current = {
    figures: payslipFigures({ payroll: { final_pay: { breakdown: fp } } }, { subsidyTreatment: treatment }),
    month: Number(String(releaseOn).slice(5, 7)) || 12,
    // The 13th month and an "other benefit" subsidy join the benefits ledger once saved.
    benefits: [
      { kind: "thirteenth_month", amount: fp.thirteenth_month || 0 },
      { kind: "subsidy_payout", amount: treatment === "other_benefit" ? fp.subsidy?.payout || 0 : 0 },
    ].filter((b) => b.amount > 0),
  };
  const adjustment = yearEndAdjustment({
    year, employee: pending.employee, prior: pending.prior, current, ceiling: pending.ceiling, taxTable: pending.taxTable, available: fp.net_pay,
  });
  return applyYearEndToFinalPay(fp, adjustment, { annualizationId: pending.record.id, taxYear: year });
}

/** Separation types (alpha test A7) mapped from HR's separation reasons. */
const SEPARATION_TYPES = ["Resignation", "End of contract", "Termination", "Retirement", "Other"];
const TYPE_OF_REASON = { Resigned: "Resignation", "End of contract": "End of contract", Terminated: "Termination", Retired: "Retirement" };
const CLEARANCE_STATUSES = ["Pending", "Cleared", "Not required"];

/** HR's separation record: date, type, reason, who recorded it and when. */
async function separationRecord(supabase, person) {
  const change = await supabase.from("employee_status_changes").select("effective_on,reason,changed_by_name,changed_at")
    .eq("employee_id", person.id).eq("new_status", "Separated").order("changed_at", { ascending: false }).limit(1).maybeSingle();
  return {
    separated_on: person.separated_on,
    type: TYPE_OF_REASON[person.separation_reason] || (person.separation_reason ? "Other" : null),
    hr_reason: person.separation_reason || change.data?.reason || null,
    recorded_by: change.data?.changed_by_name || null,
    recorded_at: change.data?.changed_at || null,
  };
}

/** The reference, clearance and notes the Accountant adds; checked. */
function separationDetails(body) {
  const d = body?.separation || {};
  const type = normalizeText(d.type);
  const reference = normalizeText(d.reference_no).slice(0, 80);
  const clearance = normalizeText(d.clearance_status) || "Pending";
  const notes = normalizeText(d.notes);
  if (type && !SEPARATION_TYPES.includes(type)) return { error: "Choose the type of separation." };
  if (!CLEARANCE_STATUSES.includes(clearance)) return { error: "Choose the clearance status." };
  if (notes.length > 1000) return { error: "Notes: at most 1,000 characters." };
  return { value: { ...(type ? { type } : {}), reference_no: reference || null, clearance_status: clearance, notes: notes || null } };
}

/**
 * Unused leave with pay this year, valued at the daily rate, as its own line.
 * Paid only when HR or the Super Admin has switched the conversion on
 * (decision 2026-11-09 #1, src/lib/payroll/leave-conversion.js); off by
 * default. Withholding tax on it is not computed (open decision).
 */
async function unusedLeave(supabase, person, daily) {
  const year = Number(String(person.separated_on).slice(0, 4));
  const leaves = await supabase.from("leave_requests").select("leave_type,start_date,end_date,status,pay_status,employee_id").eq("employee_id", person.id);
  const approved = (leaves.data || []).map((l) => ({ ...l, status: String(l.status || "").toLowerCase(), pay_status: String(l.pay_status || "").toLowerCase().includes("without") ? "without_pay" : "with_pay" }));
  // Vacation, sick and emergency credits left (maternity / paternity are not converted).
  const all = (await leaveBalances(supabase, [person.id], year, { requests: approved }))[person.id];
  const balance = { with_pay_remaining: all?.sil_remaining ?? 0 };
  const setting = await loadLeaveConversion(supabase);
  const { paid_days: paidDays, amount } = leaveConversionAmount(setting, balance.with_pay_remaining, daily);
  return {
    enabled: setting.enabled,
    max_days: setting.max_days,
    days: balance.with_pay_remaining,
    paid_days: paidDays,
    daily,
    would_be: peso(balance.with_pay_remaining * (Number(daily) || 0)),
    amount: peso(amount),
    note: setting.enabled
      ? `On${setting.max_days ? `, up to ${setting.max_days} days` : ""}: paid as its own line. Withholding tax on it is not computed.`
      : "Off until the school confirms whether unused leave is converted to cash, and for how many days (HR or the Super Admin can switch it on).",
  };
}

/** The conversion line joins the earnings, gross and net when it pays something. */
function addLeaveConversion(breakdown, conversion) {
  if (!conversion?.enabled || !(conversion.amount > 0)) return breakdown;
  breakdown.earnings.push({ kind: "leave_conversion", label: "Unused leave conversion", amount: conversion.amount, note: `${conversion.paid_days} day${Number(conversion.paid_days) === 1 ? "" : "s"} × daily rate` });
  breakdown.gross = peso(breakdown.gross + conversion.amount);
  breakdown.net_pay = peso(breakdown.net_pay + conversion.amount);
  breakdown.leave_conversion = conversion.amount;
  return breakdown;
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
      let correcting = null;
      if (url.searchParams.get("correction") === "1") {
        const entry = await supabase.from("payroll_entries").select("id").eq("employee_id", person.id).eq("pay_period", finalPayLabel(person.separated_on)).eq("status", "paid").maybeSingle();
        const approved = entry.data ? await supabase.from(SUBMISSIONS).select("effects").eq("entry_id", entry.data.id).eq("status", "approved").order("decided_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
        if (entry.data) correcting = { entry_id: entry.data.id, subsidy_before: approved.data?.effects?.subsidy_before || null };
      }
      const { input, salary, daily, year } = await gather(supabase, person, correcting);
      const breakdown = computeFinalPay(input);
      settleYearEndTax(breakdown, await pendingYearEndTax(supabase, person, year), { year, releaseOn: today, input });
      const [separation, leaveConversion] = await Promise.all([separationRecord(supabase, person), unusedLeave(supabase, person, daily)]);
      addLeaveConversion(breakdown, leaveConversion);
      return NextResponse.json({
        person: { id: person.id, full_name: person.full_name, employee_id: person.employee_id, separated_on: person.separated_on },
        salary, daily, breakdown, separation, leave_conversion: leaveConversion,
        separation_types: SEPARATION_TYPES, clearance_statuses: CLEARANCE_STATUSES,
      });
    }

    const saved = people.length
      ? await fetchAllIn(() => supabase.from("payroll_entries").select("id,employee_id,pay_period,payslip_no,payroll,status").like("pay_period", "Final pay%").order("id", { ascending: true }), "employee_id", people.map((p) => p.id))
      : { data: [] };
    const submissions = people.length
      ? await fetchAllIn(() => supabase.from(SUBMISSIONS).select("*").order("submitted_at", { ascending: false }).order("id", { ascending: true }), "employee_id", people.map((p) => p.id))
      : { data: [] };
    return NextResponse.json({
      people: people.map((p) => {
        const entry = (saved.data || []).find((e) => e.employee_id === p.id);
        // Newest first: the latest submission is the current state.
        const mine = (submissions.data || []).filter((row) => row.employee_id === p.id).sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
        const approved = mine.find((row) => row.status === "approved");
        return {
          id: p.id, full_name: p.full_name, employee_id: p.employee_id, separated_on: p.separated_on,
          // The deadline runs until HR approves (DOLE Labor Advisory 06-2020).
          ...deadlineOf(p.separated_on, today), released: Boolean(entry),
          final_pay: entry ? { payslip_no: entry.payslip_no, net_pay: entry.payroll?.totals?.net_pay ?? null, release_on: entry.payroll?.final_pay?.release_on || null,
            overpayment_to_recover: Number(entry.payroll?.final_pay?.overpayment_to_recover) || 0,
            approval: entry.payroll?.final_pay?.approval || null, legacy: Boolean(approved?.legacy), status_label: approved?.legacy ? LEGACY_LABEL : "Paid" } : null,
          submission: shapeSubmission(mine[0]),
        };
      }),
      can_edit: guard.role === "accountant",
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "process_payroll", "create");
    if (guard.denied) return guard.denied;
    // Only the Accountant computes and submits; HR approves (20261120010000).
    if (guard.role !== "accountant") return NextResponse.json({ error: "Only the Accountant computes and submits final pay." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const supabase = getAdminClient();
    const people = await separatedPeople(supabase, guard);
    const person = people.find((p) => p.id === normalizeText(body.employee_id));
    if (!person) return NextResponse.json({ error: "Separated employee not found in your branch." }, { status: 404 });
    if (person.id === guard.userId) return NextResponse.json({ error: "You cannot process your own final pay." }, { status: 403 });
    const releaseOn = normalizeText(body.release_on, manilaDateKey());
    if (!isDate(releaseOn) || releaseOn < person.separated_on) return NextResponse.json({ error: "Choose the release date (on or after the separation)." }, { status: 400 });

    // Separation details kept with the Final Pay record (alpha test A7).
    const details = separationDetails(body);
    if (details.error) return NextResponse.json({ error: details.error }, { status: 400 });
    const label = finalPayLabel(person.separated_on);
    const [existing, pending] = await Promise.all([
      supabase.from("payroll_entries").select("id").eq("employee_id", person.id).eq("pay_period", label).eq("status", "paid").maybeSingle(),
      supabase.from(SUBMISSIONS).select("id").eq("employee_id", person.id).eq("status", "pending").maybeSingle(),
    ]);
    if (pending.data) return NextResponse.json({ error: "This final pay is waiting for HR approval and is locked until HR decides." }, { status: 409 });
    const correction = body.correction === true;
    if (existing.data && !correction) return NextResponse.json({ error: "This final pay is already released. Use Correct to send a correction to HR." }, { status: 409 });
    if (!existing.data && correction) return NextResponse.json({ error: "There is no released final pay to correct." }, { status: 400 });
    let correcting = null;
    if (correction) {
      const approved = await supabase.from(SUBMISSIONS).select("effects").eq("entry_id", existing.data.id).eq("status", "approved").order("decided_at", { ascending: false }).limit(1).maybeSingle();
      correcting = { entry_id: existing.data.id, subsidy_before: approved.data?.effects?.subsidy_before || null };
    }

    const { input, year, daily: dailyRate } = await gather(supabase, person, correcting);
    const fp = computeFinalPay(input);
    const yearEndTax = settleYearEndTax(fp, await pendingYearEndTax(supabase, person, year), { year, releaseOn, input });
    const conversion = await unusedLeave(supabase, person, dailyRate);
    addLeaveConversion(fp, conversion);
    const now = new Date().toISOString();
    const payroll = {
      basic_salary: input.monthlySalary,
      basic_earned: fp.basic_earned,
      final_pay: {
        separated_on: person.separated_on, release_on: releaseOn, breakdown: fp, computed_by_name: actorName(guard),
        // Not deducted from anything: HR recovers it by hand (2026-11-15).
        overpayment_to_recover: fp.overpayment_to_recover || 0,
        separation: { ...(await separationRecord(supabase, person)), ...details.value, recorded_in_final_pay_by: actorName(guard), recorded_in_final_pay_at: new Date().toISOString() },
        // Unused leave conversion (decision 2026-11-09 #1): as set when generated.
        leave_conversion: { enabled: conversion.enabled, max_days: conversion.max_days, days: conversion.days, paid_days: conversion.paid_days, amount: conversion.amount },
      },
      totals: { gross_pay: fp.gross, total_deductions: fp.total_deductions, total_incentives: 0, net_pay: fp.net_pay },
      ...(yearEndTax ? { year_end_tax: yearEndTax } : {}),
    };
    // What payroll_commit_entries writes when HR approves (payroll_final_pay_decide).
    const item = {
      record: {
        employee_id: person.id, employee_name: person.full_name, employee_type: person.employee_type,
        gross_pay: fp.gross, total_deductions: fp.total_deductions, net_pay: fp.net_pay, period_label: label,
        processed_at: now, base_pay: input.monthlySalary, total_incentives: 0,
        period_start: input.months[0]?.window.start_key || person.separated_on, period_end: person.separated_on,
        processed_by: guard.userId || null, processed_by_name: actorName(guard),
      },
      entry: { id: existing.data?.id || crypto.randomUUID(), employee_id: person.id, employee_name: person.full_name, employee_code: person.employee_id, employee_type: person.employee_type,
        position: person.position || null, pay_period: label, status: "paid", payroll, submitted_at: now, created_at: now, updated_at: now },
      deductions: fp.deductions.filter((d) => ["sss", "philhealth", "pagibig", "withholding_tax", "carry_over", "loan", "year_end_tax"].includes(d.kind) && !d.credit)
        .map((d) => ({ type: d.kind, quantity: null, unit: null, rate: null, amount: d.amount, is_override: true, note: d.note || `Final pay${d.month_key ? ` (${d.month_key})` : ""}` })),
      // A year-end tax refund is its own line.
      incentives: [
        ...fp.deductions.filter((d) => d.kind === "year_end_tax" && d.credit)
          .map((d) => ({ type: "year_end_tax_refund", quantity: 1, unit: "year", rate: null, amount: d.amount, is_override: false, note: d.note })),
        ...(conversion.amount > 0 ? [{ type: "leave_conversion", quantity: conversion.paid_days, unit: "day", rate: conversion.daily, amount: conversion.amount, is_override: true, note: "Unused leave conversion" }] : []),
      ],
      loan_payments: fp.loan_payments,
    };
    // Held while pending (the database refuses any other use), written on approval.
    const effects = {
      loan_ids: [...new Set([...fp.loan_payments, ...fp.uncovered].map((l) => l.loan_id))],
      thirteenth: fp.thirteenth_month > 0 ? { year, basic_earned: peso(input.basicEarnedYtd + fp.basic_earned), amount: fp.thirteenth_month } : null,
      subsidy: fp.subsidy?.balance_id ? { balance_id: fp.subsidy.balance_id, payout: fp.subsidy.payout, forfeited: fp.subsidy.forfeited } : null,
      subsidy_before: correcting ? correcting.subsidy_before : input.subsidy?.before || null,
      uncovered: fp.uncovered,
    };
    const { data: saved, error } = await supabase.from(SUBMISSIONS).insert({
      employee_id: person.id, employee_name: person.full_name, branch_id: person.branch_id || null, separated_on: person.separated_on,
      status: "pending", release_on: releaseOn, net_pay: fp.net_pay, item, effects, corrects_entry_id: correcting?.entry_id || null,
      submitted_by: guard.userId || null, submitted_by_name: actorName(guard),
    }).select("id").single();
    if (error) {
      if (String(error.code) === "23505") return NextResponse.json({ error: "This final pay is already waiting for HR approval." }, { status: 409 });
      throw new Error(error.message);
    }

    // HR of the employee's branch (an HR without a home branch reaches every branch); generic, no amount.
    try {
      const hr = await supabase.from("profiles").select("id,branch_id").eq("role", "hr").eq("archived", false);
      const ids = (hr.data || []).filter((h) => !h.branch_id || h.branch_id === person.branch_id).map((h) => h.id);
      await notify(supabase, ids.length ? ids : await hrAccountIds(supabase), {
        kind: "final_pay_submitted",
        title: correction ? "Final pay correction waiting for approval" : "Final pay waiting for approval",
        body: `The final pay for ${person.full_name} is waiting for your approval.${fp.overpayment_to_recover > 0 ? " It shows an overpayment to recover." : ""}`,
        link_page: "hr-final-pay-approvals",
      });
    } catch { /* the submission is saved either way */ }
    await appendAuditLog({
      actor: guard, module: "payroll", action: correction ? "final_pay_correction_submitted" : "final_pay_submitted", entity_type: "final_pay_submission", entity_id: saved.id, status: "success", source: "api",
      description: `${correction ? "Final pay correction" : "Final pay"} for ${personLabel(person)} (separated ${person.separated_on}) submitted for HR approval: net ${fp.net_pay.toFixed(2)}, release ${releaseOn}${fp.uncovered.length ? `; ${fp.uncovered.length} loan balance(s) for collection` : ""}.`,
      metadata: { net_pay: fp.net_pay, release_on: releaseOn, overpayment_to_recover: fp.overpayment_to_recover || 0, correction },
    });
    return NextResponse.json({ success: true, id: saved.id, status: "pending", net_pay: fp.net_pay, overpayment_to_recover: fp.overpayment_to_recover || 0 });
  } catch (error) {
    if (error?.status) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
