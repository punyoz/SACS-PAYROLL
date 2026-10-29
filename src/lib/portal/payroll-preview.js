/**
 * The Accountant's payroll PREVIEW, line for line from public/legacy/js/
 * accountant.js (employeePayInfo, computeAttendanceAmounts,
 * acctWithholdingTax, contributionDefaults, taxDefaultFor, recalc,
 * computeBatchRowNetPay, getFormDeviations). Attendance figures, rates,
 * defaults and the tax table come from GET /api/accountant/payroll; the
 * server recomputes everything when a payroll is saved or processed
 * (src/app/api/accountant/payroll/route.js). Nothing here is authoritative.
 *
 * `data` is that GET payload. Keep this file in step with accountant.js.
 */

import { requiresApproval } from "@/lib/payroll/runs";

export function toAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

export const same = (a, b) => Math.abs(toAmount(a) - toAmount(b)) < 0.005;

export { SALARY_MAX } from "@/lib/input-limits";

/** "₱ 12,345.00" (formatMoney, accountant.js). */
export function money(value) {
  return `₱ ${toAmount(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "₱ 12,345" (formatMoneyCompact). */
export function moneyCompact(value) {
  return `₱ ${toAmount(value).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

const FALLBACK_RATES = {
  hourly: 68.75, daily: 550, half_day_pct: 50, absent_pct: 100,
  late_days_per_absent: 3, late_minute_charge_pct: 0,
  perfect_attendance_bonus: 0, sss_pct: 2, philhealth_pct: 2, pagibig_pct: 2,
};

/** 'first' | 'second' | null: the semi-monthly half of the active period. */
export function semiHalf(data) {
  return data?.semi_monthly?.half || null;
}

/** The attendance row, rates and unit amounts for one employee. */
export function employeePayInfo(data, employeeId) {
  const row = (data?.attendance_rows || []).find((r) => r.employee_id === employeeId) || null;
  const rates = { ...FALLBACK_RATES, ...(row?.rates || {}) };
  const unit = row?.pay?.unit_amounts || {
    hourly: rates.hourly,
    daily: rates.daily,
    half_day: toAmount(rates.daily * rates.half_day_pct / 100),
    absent: toAmount(rates.daily * rates.absent_pct / 100),
    perfect_attendance: rates.perfect_attendance_bonus,
    late_days_per_absent: rates.late_days_per_absent,
    late_minute_pct: rates.late_minute_charge_pct,
  };
  return { row, rates, unit, pay: row?.pay || null };
}

/** The server's default basic for the period (monthly salary in a 2nd half). */
export function basicDefaultFor(data, employee) {
  const row = (data?.attendance_rows || []).find((r) => r.employee_id === employee?.id);
  const fallback = toAmount(Number(employee?.basic_salary || 0) / 2);
  return row?.defaults?.basic_salary !== undefined ? toAmount(row.defaults.basic_salary) : fallback;
}

/** What a 2nd half adds and settles against, from the server's preview. */
export function semiExtras(info) {
  const d = info.row?.defaults || {};
  return {
    other: toAmount(Number(d.other_incentive || 0) + Number(d.overload_pay || 0)),
    overloadHours: toAmount(d.overload_hours || 0),
    firstHalfPaid: toAmount(d.first_half_paid || 0),
    firstHalfStatus: d.first_half_status || "not_processed",
    carryIn: toAmount(d.carry_in || 0),
    // Licensed-teacher subsidy (2nd half): paid, and its taxable part.
    subsidy: toAmount(d.subsidy_pay || 0),
    subsidyTaxable: toAmount(d.subsidy_taxable || 0),
    // After a per-cutoff 1st half: the attendance it deducted and what it
    // paid beyond its Rate, both part of the month that is taxed.
    priorAttendance: toAmount(d.prior_attendance || 0),
    priorEarnings: toAmount(d.prior_earnings || 0),
  };
}

/** The period's Early Bird incentive when this employee won it (either half). */
export function earlyBirdWinnerPay(info) {
  return toAmount(info.row?.defaults?.early_bird_winner || 0);
}

/** True when the period's 1st half deducts its own attendance (per-cutoff). */
export function perCutoffFirst(data) {
  return semiHalf(data) === "first" && Boolean(data?.semi_monthly?.per_cutoff);
}

/**
 * Attendance amounts for the quantities shown: a quantity equal to the
 * computed one uses the computed, per-log total; a changed quantity is
 * priced at the unit rate (buildEmployeePayroll on the server).
 */
export function computeAttendanceAmounts(info, q) {
  const { unit, pay } = info;
  const counts = pay?.counts || {};
  const amounts = pay?.amounts || {};
  const price = (quantity, computedQuantity, computedAmount, perUnit) => (
    pay && same(quantity, computedQuantity) ? toAmount(computedAmount) : toAmount(quantity * perUnit)
  );
  return {
    absent: price(q.absences_days, counts.absent_days, amounts.absent, unit.absent),
    late: pay && same(q.late_days, counts.late_days)
      ? toAmount(amounts.late)
      : toAmount(
        (unit.late_days_per_absent > 0 ? Math.floor(toAmount(q.late_days) / unit.late_days_per_absent) * unit.absent : 0)
        + toAmount(amounts.late_minutes_charge),
      ),
    undertime: price(q.undertime_minutes, counts.undertime_minutes, amounts.undertime, unit.hourly / 60),
    half_day: price(q.half_days, counts.half_days, amounts.half_day, unit.half_day),
    perfect_attendance: pay && Boolean(q.perfect_attendance) === Boolean(pay.perfect_attendance)
      ? toAmount(amounts.perfect_attendance)
      : (q.perfect_attendance ? toAmount(unit.perfect_attendance) : 0),
  };
}

/** Withholding tax for one period from the BIR table the server sent. */
export function withholdingTax(data, taxable) {
  const table = Array.isArray(data?.tax_table) ? data.tax_table : [];
  if (!table.length) return 0;
  const amount = Math.max(0, toAmount(taxable));
  let bracket = table[0];
  table.forEach((row) => { if (amount > Number(row.over)) bracket = row; });
  return toAmount(Number(bracket.base) + (amount - Number(bracket.over)) * Number(bracket.rate));
}

export function usesLegalTables(info) {
  return info.row?.defaults?.statutory_method === "legal";
}

/**
 * True when SSS, PhilHealth, Pag-IBIG and withholding tax are computed by the
 * server and cannot be typed (2026-10-26): the form shows them read-only,
 * never counts them as overrides and never sends them.
 */
export function governmentLocked(info) {
  return info.row?.defaults?.government_locked === true;
}

/** SSS / PhilHealth / Pag-IBIG defaults (legal tables from the server, else flat % of basic). */
export function contributionDefaults(data, info, basic) {
  const defaults = info.row?.defaults;
  if (semiHalf(data) === "first") return { sss: 0, philhealth: 0, pagibig: 0 };
  if (usesLegalTables(info)) {
    return { sss: toAmount(defaults.sss), philhealth: toAmount(defaults.philhealth), pagibig: toAmount(defaults.pagibig) };
  }
  return {
    sss: toAmount(basic * info.rates.sss_pct / 100),
    philhealth: toAmount(basic * info.rates.philhealth_pct / 100),
    pagibig: toAmount(basic * info.rates.pagibig_pct / 100),
  };
}

/** Approved overtime and holiday pay, computed from the logs on the server. */
export function earningsFor(info) {
  const amounts = info.pay?.amounts || {};
  return { overtime: toAmount(amounts.overtime || 0), holiday: toAmount(amounts.holiday_premium || 0) };
}

/** Default withholding tax for the figures shown (zero before the legal tables and in a 1st half). */
export function taxDefaultFor(data, info, { basic, earnings, attendanceDeductions, contributions, incentives = 0 }) {
  if (semiHalf(data) === "first" || !usesLegalTables(info)) return 0;
  const extra = semiHalf(data) === "second" ? toAmount(incentives) : 0;
  // A per-cutoff 1st half's attendance and extra earnings are part of the month.
  const prior = semiHalf(data) === "second" ? semiExtras(info) : { priorAttendance: 0, priorEarnings: 0 };
  const taxable = Math.max(0, toAmount(basic + earnings + extra + prior.priorEarnings - attendanceDeductions - prior.priorAttendance - contributions));
  return withholdingTax(data, taxable);
}

export function describeBlockingDays(blocking) {
  return (blocking || []).map((b) => `${b.log_date} (${b.status})`).join(", ");
}

/** The form's starting values for an employee (syncFormForEmployee + autoFill*). */
export function defaultForm(data, employee) {
  const info = employeePayInfo(data, employee?.id);
  const basic = basicDefaultFor(data, employee);
  const contributions = contributionDefaults(data, info, basic);
  const counts = info.pay?.counts || {};
  const leave = (data?.leave_summary || []).find((row) => row.employee_id === employee?.id);
  return {
    basic: String(basic),
    sss: String(contributions.sss),
    philhealth: String(contributions.philhealth),
    pagibig: String(contributions.pagibig),
    tax: "0",
    taxEdited: false,
    absences: String(counts.absent_days || 0),
    late: String(counts.late_days || 0),
    undertime: String(counts.undertime_minutes || 0),
    halfDays: String(counts.half_days || 0),
    lwp: String(leave?.with_pay_days || 0),
    lwop: String(leave?.without_pay_days || 0),
    perfect: Boolean(info.pay?.perfect_attendance),
    overrideReason: "",
  };
}

/** The form filled from a saved draft (populateFormFromDraft). */
export function formFromDraft(draft) {
  const payroll = draft.payroll || {};
  const d = payroll.deductions || {};
  const n = (v) => String(Number(v || 0));
  return {
    basic: n(payroll.basic_salary),
    sss: n(d.sss),
    philhealth: n(d.philhealth),
    pagibig: n(d.pagibig),
    tax: n(d.withholding_tax),
    // A draft keeps a typed tax; otherwise the tax follows the figures again.
    taxEdited: (payroll.audit?.deviations?.items || []).some((x) => x.field === "withholding_tax"),
    absences: n(d.absences_days),
    late: n(d.late_days ?? 0),
    undertime: n(d.undertime_minutes ?? 0),
    halfDays: n(d.half_days ?? 0),
    lwp: n(d.leave_with_pay_days ?? 0),
    lwop: n(d.leave_without_pay_days ?? 0),
    perfect: Boolean(payroll.incentives?.perfect_attendance),
    overrideReason: payroll.audit?.deviations?.reason || "",
  };
}

/**
 * 1st half (applyFirstHalfLock): no contributions or tax. Before per-cutoff
 * attendance it deducted nothing at all; from it, its own attendance stays.
 */
export function lockFirstHalf(data, form) {
  if (semiHalf(data) !== "first") return form;
  if (perCutoffFirst(data)) return { ...form, sss: "0", philhealth: "0", pagibig: "0", tax: "0" };
  return { ...form, sss: "0", philhealth: "0", pagibig: "0", tax: "0", absences: "0", late: "0", undertime: "0", halfDays: "0", lwp: "0", lwop: "0", perfect: false };
}

/** The Computation Summary for the form (recalc). Returns every figure shown. */
export function computeSummary(data, employee, rawForm) {
  const form = lockFirstHalf(data, rawForm);
  const g = (key) => toAmount(form[key]);
  const basic = g("basic");
  const lwpDays = g("lwp");
  const lwopDays = g("lwop");
  const info = employeePayInfo(data, employee?.id);
  // Locked: the computed contributions, never what a form field holds.
  const locked = governmentLocked(info);
  const computedContributions = locked ? contributionDefaults(data, info, basic) : null;
  const sss = locked ? computedContributions.sss : g("sss");
  const philhealth = locked ? computedContributions.philhealth : g("philhealth");
  const pagibig = locked ? computedContributions.pagibig : g("pagibig");
  const amounts = computeAttendanceAmounts(info, {
    absences_days: g("absences"),
    late_days: g("late"),
    undertime_minutes: g("undertime"),
    half_days: g("halfDays"),
    perfect_attendance: form.perfect,
  });
  const lwopDeduct = toAmount(lwopDays * info.unit.daily);
  // The period's Early Bird winner is paid as an incentive on either half.
  const incentives = toAmount(amounts.perfect_attendance + earlyBirdWinnerPay(info));
  const earnings = earningsFor(info);
  const gross = toAmount(basic + earnings.overtime + earnings.holiday);
  const settling = semiHalf(data) === "second";
  const extras = settling ? semiExtras(info) : { other: 0, firstHalfPaid: 0, carryIn: 0, firstHalfStatus: "not_processed", subsidy: 0, subsidyTaxable: 0, priorAttendance: 0, priorEarnings: 0 };
  if (!settling && info.row?.defaults?.per_half) extras.other = semiExtras(info).other;
  // Cash advance installments plus loan amortizations (both net-only).
  const cashAdvance = toAmount(Number(info.row?.defaults?.cash_advance || 0) + Number(info.row?.defaults?.loan || 0));

  const taxDefault = taxDefaultFor(data, info, {
    basic,
    earnings: earnings.overtime + earnings.holiday,
    attendanceDeductions: amounts.absent + amounts.late + amounts.undertime + amounts.half_day + lwopDeduct,
    contributions: sss + philhealth + pagibig,
    incentives: incentives + extras.other + (extras.subsidyTaxable || 0),
  });
  // The tax follows the figures (until the accountant types one, where typing is allowed).
  const tax = form.taxEdited && !locked ? g("tax") : taxDefault;
  const totalDeductions = toAmount(sss + philhealth + pagibig + tax + amounts.absent + amounts.late + amounts.undertime + amounts.half_day + lwopDeduct + cashAdvance);
  const monthNet = toAmount(gross - totalDeductions + incentives + extras.other + (extras.subsidy || 0)
    + (extras.priorEarnings || 0) - (extras.priorAttendance || 0));
  // Year-end tax adjustment on a 2nd cutoff (+ deducted, − refunded; src/lib/payroll/year-end-tax.js).
  const yearEndTax = settling ? toAmount(info.row?.defaults?.year_end_tax || 0) : 0;
  const secondHalfNet = toAmount(monthNet - extras.firstHalfPaid - extras.carryIn);
  const net = Math.max(0, settling ? toAmount(secondHalfNet - yearEndTax) : monthNet);
  return {
    info, basic, sss, philhealth, pagibig, tax, taxDefault, amounts, lwpDays, lwopDeduct, incentives, earnings, gross,
    settling, extras, cashAdvance, monthNet, secondHalfNet, net, yearEndTax,
    shownIncentives: incentives + (settling ? 0 : extras.other),
  };
}

/** Manual changes from the computed defaults, for the override reason (getFormDeviations). */
export function formDeviations(data, employee, rawForm, taxDefault) {
  if (!employee) return [];
  const form = lockFirstHalf(data, rawForm);
  const info = employeePayInfo(data, employee.id);
  const counts = info.pay?.counts || {};
  const leave = (data?.leave_summary || []).find((row) => row.employee_id === employee.id);
  const g = (key) => toAmount(form[key]);
  const basic = g("basic");
  if (semiHalf(data) === "first" && !perCutoffFirst(data)) {
    return same(basicDefaultFor(data, employee), basic) ? [] : [`Basic Salary: ${basicDefaultFor(data, employee)} → ${basic}`];
  }
  const contributions = contributionDefaults(data, info, basic);
  const tax = form.taxEdited ? g("tax") : taxDefault;
  // Computed government deductions are never an override (2026-10-26).
  const government = governmentLocked(info) ? [] : [
    ["SSS", contributions.sss, g("sss")],
    ["PhilHealth", contributions.philhealth, g("philhealth")],
    ["Pag-IBIG", contributions.pagibig, g("pagibig")],
    ...(usesLegalTables(info) ? [["Withholding Tax", taxDefault, tax]] : []),
  ];
  const checks = [
    ["Basic Salary", basicDefaultFor(data, employee), basic],
    ...government,
    ["Leave Without Pay", leave?.without_pay_days || 0, g("lwop")],
    ["Absent", counts.absent_days || 0, g("absences")],
    ["Late", counts.late_days || 0, g("late")],
    ["Undertime", counts.undertime_minutes || 0, g("undertime")],
    ["Half Day", counts.half_days || 0, g("halfDays")],
  ];
  const deviations = checks.filter(([, def, value]) => !same(def, value)).map(([label, def, value]) => `${label}: ${def} → ${value}`);
  if (info.pay && form.perfect !== Boolean(info.pay.perfect_attendance)) {
    deviations.push(`Perfect Attendance: ${info.pay.perfect_attendance ? "Yes" : "No"} → ${form.perfect ? "Yes" : "No"}`);
  }
  return deviations;
}

/** The submission body for the single form (buildSubmissionPayload). */
export function submissionPayload(action, { entryId, employee, period, form: rawForm, tax, data }) {
  const form = lockFirstHalf(data, rawForm);
  const g = (key) => toAmount(form[key]);
  // Computed government deductions are not sent at all (the server computes
  // them and refuses a different value).
  const locked = governmentLocked(employeePayInfo(data, employee.id));
  const government = locked ? {} : { sss: g("sss"), philhealth: g("philhealth"), pagibig: g("pagibig"), withholding_tax: tax };
  return {
    action,
    entry_id: entryId || undefined,
    employee_id: employee.id,
    pay_period: period,
    // The basic salary is never sent: the server uses the one in force (2026-10-26).
    allowances: { transportation: 0, rice: 0, overtime: 0, bonus: 0 },
    deductions: {
      ...government,
      absences_days: g("absences"),
      late_days: g("late"),
      undertime_minutes: g("undertime"),
      half_days: g("halfDays"),
      leave_with_pay_days: g("lwp"),
      leave_without_pay_days: g("lwop"),
    },
    incentives: { perfect_attendance: form.perfect },
    override_reason: String(form.overrideReason || "").trim(),
    reason: "Payroll processed by accountant.",
  };
}

/* ── Batch ── */

/** Net Pay of one batch row (computeBatchRowNetPay). */
export function batchRowNet(row) {
  const lwopDeduct = toAmount(row.leave_without_pay_days * row.daily_rate);
  const totalDeductions = toAmount(row.sss + row.philhealth + row.pagibig + row.tax + row.attendance_deductions + lwopDeduct + (row.cash_advance || 0));
  const monthNet = toAmount(row.basic_salary + (row.earnings || 0) - totalDeductions + row.incentives + (row.other_incentives || 0)
    + (row.prior_earnings || 0) - (row.prior_attendance || 0));
  return Math.max(0, toAmount(monthNet - (row.first_half_paid || 0) - (row.carry_in || 0) - (row.year_end_tax || 0)));
}

/** Everything one batch row starts from (loadBatchPayrollTable). */
export function batchRowBase(data, employee) {
  const basic = basicDefaultFor(data, employee);
  const info = employeePayInfo(data, employee.id);
  const half = semiHalf(data);
  const extras = half === "second" || info.row?.defaults?.per_half ? semiExtras(info) : { other: 0, overloadHours: 0, firstHalfPaid: 0, carryIn: 0 };
  // Cash advance installments plus loan amortizations (both net-only).
  const cashAdvance = toAmount(Number(info.row?.defaults?.cash_advance || 0) + Number(info.row?.defaults?.loan || 0));
  // Year-end tax adjustment (+ deducted, − refunded), 2nd cutoff only.
  const yearEndTax = half === "second" ? toAmount(info.row?.defaults?.year_end_tax || 0) : 0;
  // Before per-cutoff attendance the 1st half counted no attendance at all.
  const noAttendance = half === "first" && !perCutoffFirst(data);
  const counts = noAttendance ? {} : info.pay?.counts || {};
  const amounts = noAttendance ? {} : info.pay?.amounts || {};
  const blocking = noAttendance ? [] : info.pay?.blocking || [];
  const legal = usesLegalTables(info);
  const contributions = contributionDefaults(data, info, basic);
  const leave = (data?.leave_summary || []).find((row) => row.employee_id === employee.id);
  const lwp = noAttendance ? 0 : leave?.with_pay_days || 0;
  const lwop = noAttendance ? 0 : leave?.without_pay_days || 0;
  const attendanceDeductions = toAmount((amounts.absent || 0) + (amounts.late || 0) + (amounts.undertime || 0) + (amounts.half_day || 0));
  const incentives = toAmount((amounts.perfect_attendance || 0) + earlyBirdWinnerPay(info));
  const e = earningsFor(info);
  const earnings = toAmount(e.overtime + e.holiday);
  return { info, half, basic, extras, cashAdvance, yearEndTax, counts, amounts, blocking, legal, contributions, lwp, lwop, attendanceDeductions, incentives, earnings };
}

/** The row's tax default for its current figures (recalcBatchRow). */
export function batchTaxDefault(data, base, { sss, philhealth, pagibig, lwop }) {
  return taxDefaultFor(data, base.info, {
    basic: base.basic,
    earnings: base.earnings,
    attendanceDeductions: base.attendanceDeductions + toAmount(lwop * base.info.unit.daily),
    contributions: sss + philhealth + pagibig,
    incentives: base.incentives + base.extras.other + (base.extras.subsidyTaxable || 0),
  });
}

/** Status label and tone (statusMeta, accountant.js). */
export function statusMeta(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid" || s === "approved") return { label: "Paid", tone: "success" };
  // Same wording as recordStatusMeta (2026-10-20); "On hold" is an entry
  // the Accountant held back, not an HR decision.
  if (s === "rejected") return { label: "Rejected by HR", tone: "danger" };
  if (s === "on_hold") return { label: "On hold", tone: "danger" };
  if (s === "draft") return { label: "Not submitted to HR", tone: "info" };
  return { label: "Pending HR Approval", tone: "gold" };
}

/**
 * A processed record's status as the Accountant sees it: from Oct 1, 2026 a
 * processed payslip is Paid only once HR approves its branch's run
 * (record.run_status, GET /api/accountant/payroll), not when it is processed.
 */
export function recordStatusMeta(record) {
  const s = String(record?.status || "").toLowerCase();
  // Exactly four labels (2026-10-20). A Draft has not gone to HR either.
  if (s === "draft") return { label: "Not submitted to HR", tone: "info" };
  if (s === "on_hold" || s === "rejected" || !requiresApproval(record?.pay_period)) return statusMeta(record?.status);
  if (record.run_status === "approved") return { label: "Paid", tone: "success" };
  if (record.run_status === "pending") return { label: "Pending HR Approval", tone: "gold" };
  if (record.run_status === "rejected") return { label: "Rejected by HR", tone: "danger" };
  return { label: "Not submitted to HR", tone: "info" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12" -> "Oct 12, 2026" (acctDateLabel). */
export function dateLabel(key) {
  const [y, m, d] = String(key || "").split("-").map(Number);
  return y && m && d ? `${MONTHS[m - 1]} ${d}, ${y}` : String(key || "");
}

/** "2026-10-12" -> "Oct 12" (acctShortDate). */
export function shortDate(key) {
  const [y, m, d] = String(key || "").split("-").map(Number);
  return y && m && d ? `${MONTHS[m - 1]} ${d}` : String(key || "");
}

/** "Oct 07, 2026, 08:01 AM" (formatDateTime, accountant.js). */
export function dateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-PH", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
