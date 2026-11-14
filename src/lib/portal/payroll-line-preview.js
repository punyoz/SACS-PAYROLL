/**
 * The Process Payroll Computation Summary as grouped, tagged lines
 * (src/lib/payroll/line-tags.js), from exactly the figures computeSummary()
 * shows (src/lib/portal/payroll-preview.js) and the rates and bases the
 * server sent with them. A preview: the server recomputes on processing.
 */

import { buildLineGroups, overridesFromDeviations, pesoText, withSssLimits } from "@/lib/payroll/line-tags";
import { earlyBirdWinnerPay, same, semiHalf, toAmount, usesLegalTables } from "@/lib/portal/payroll-preview";

/**
 * Taxable income for the figures shown: the same sum taxDefaultFor() taxes
 * (gross + taxable extras − attendance − the employee's contributions).
 * null when no tax is computed (a 1st half, or before the legal tables).
 */
export function previewTaxableIncome(data, summary) {
  const info = summary.info;
  if (semiHalf(data) === "first" || !usesLegalTables(info)) return null;
  const a = summary.amounts;
  const second = semiHalf(data) === "second";
  const extras = summary.extras || {};
  const extra = second ? toAmount(summary.incentives + (extras.other || 0) + (extras.subsidyTaxable || 0)) : 0;
  const prior = second ? { attendance: extras.priorAttendance || 0, earnings: extras.priorEarnings || 0 } : { attendance: 0, earnings: 0 };
  const attendance = a.absent + a.late + a.undertime + a.half_day + summary.lwopDeduct;
  return Math.max(0, toAmount(summary.basic + summary.earnings.overtime + summary.earnings.holiday + extra + prior.earnings
    - attendance - prior.attendance - (summary.sss + summary.philhealth + summary.pagibig)));
}

/** form vs the computed attendance -> { absent: { reason, from, to }, … } */
function formOverrides(info, form, computedForm) {
  const items = [
    ["absences_days", computedForm.absences, form.absences],
    ["late_days", computedForm.late, form.late],
    ["undertime_minutes", computedForm.undertime, form.undertime],
    ["half_days", computedForm.halfDays, form.halfDays],
    ["leave_without_pay_days", computedForm.lwop, form.lwop],
  ].filter(([, from, to]) => !same(from, to)).map(([field, from, to]) => ({ field, default: toAmount(from), value: toAmount(to) }));
  if (info.pay && Boolean(form.perfect) !== Boolean(computedForm.perfect)) items.push({ field: "perfect_attendance", default: Boolean(computedForm.perfect), value: Boolean(form.perfect) });
  return overridesFromDeviations({ items, reason: String(form.overrideReason || "").trim() || "reason required before processing" });
}

/**
 * @param {object} data      GET /api/accountant/payroll
 * @param {object} employee
 * @param {object} form      the form as shown (overrides locked -> computed values)
 * @param {object} summary   computeSummary(data, employee, form)
 * @param {object} computedForm  defaultForm(data, employee)
 */
export function previewLineGroups(data, employee, form, summary, computedForm) {
  if (!employee) return null;
  const info = summary.info;
  const d = info.row?.defaults || {};
  const unit = info.unit || {};
  const rates = info.rates || {};
  const half = semiHalf(data);
  const settling = summary.settling;
  const extras = summary.extras || {};
  const monthly = toAmount(employee.basic_salary);
  const winner = earlyBirdWinnerPay(info);
  const g = (key) => toAmount(form[key]);
  const taxable = previewTaxableIncome(data, summary);
  const overloadPay = toAmount(d.overload_pay || 0);
  const otherIncentive = settling ? toAmount(d.other_incentive || 0) : toAmount(extras.other || 0);
  const loanLines = [
    ...(d.loans || []).filter((l) => toAmount(l.amount) > 0).map((l) => ({ kind: "loan", label: l.description || "Loan", amount: l.amount, how: `Installment ${pesoText(l.amortization || l.amount)}; balance ${pesoText(l.balance_before)} → ${pesoText(l.balance_after)}` })),
    ...(d.cash_advances || []).filter((l) => toAmount(l.amount) > 0).map((l) => ({ kind: "cash_advance", label: l.description ? `Cash advance: ${l.description}` : "Cash advance", amount: l.amount, how: `Installment ${pesoText(l.amount)}; balance ${pesoText(l.balance_before)} → ${pesoText(l.balance_after)}` })),
  ];
  const listed = toAmount(loanLines.reduce((s, l) => s + toAmount(l.amount), 0));
  // Whatever the total holds beyond the listed lines (a subsidy advance offset).
  if (toAmount(summary.cashAdvance - listed) > 0) loanLines.push({ kind: "other", label: "Subsidy advance offset", amount: toAmount(summary.cashAdvance - listed), how: "Prior-year subsidy advance recovered as approved" });

  // After a per-cutoff 1st half the 2nd half shows its own half only
  // (decision 2026-11-14): the month less the 1st cutoff's Rate, its own
  // attendance; the whole month appears in the tax basis and reconciliation.
  const ownHalf = settling && extras.perCutoff;
  const ownBasic = ownHalf ? toAmount(summary.basic - extras.firstHalfBasic) : summary.basic;
  // Wording (2026-11-14): "Basic salary" is the fixed monthly pay of the
  // contract (the same in both halves); each half pays its "Basic pay" from it.
  const basicHow = ownHalf
    ? `Basic salary ${pesoText(summary.basic)} a month − 1st half ${pesoText(extras.firstHalfBasic)} = ${pesoText(ownBasic)}`
    : settling
    ? `Basic salary ${pesoText(summary.basic)} a month: the 2nd half computes the whole month, then takes off what the 1st half paid`
    : same(summary.basic, monthly / 2)
      ? `Basic salary ${pesoText(monthly)} a month ÷ 2 = ${pesoText(summary.basic)}`
      : `Basic pay for the period = ${pesoText(summary.basic)}`;

  const result = buildLineGroups({
    half: half === "first" ? "first" : settling ? "second" : null,
    additions: {
      basic: { label: ownHalf ? "Basic pay (2nd half)" : settling ? "Basic salary (whole month)" : half === "first" ? "Basic pay (1st half)" : "Basic pay", amount: ownBasic, how: basicHow },
      overtime: { amount: summary.earnings.overtime, minutes: info.pay?.counts?.overtime_minutes || 0, hourly: unit.hourly, premium_pct: Number(rates.overtime_premium_pct) || 0 },
      holiday: {
        amount: summary.earnings.holiday,
        pct_text: `regular holiday +${Number(rates.regular_holiday_premium_pct) || 0}%, special day +${Number(rates.special_holiday_premium_pct) || 0}% of the daily rate ${pesoText(unit.daily)}`,
      },
      early_bird: { amount: winner },
      perfect: { amount: summary.amounts.perfect_attendance },
      incentives: { amount: settling ? otherIncentive : toAmount(otherIncentive), label: "Approved incentives" },
      overload: settling ? { amount: overloadPay, hours: toAmount(d.overload_hours || 0), rate: d.overload_hours ? toAmount(overloadPay / d.overload_hours) : null } : null,
      subsidy: { amount: extras.subsidy || 0 },
      prior_earnings: ownHalf ? 0 : extras.priorEarnings || 0,
      year_end_refund: summary.yearEndTax < 0 ? -summary.yearEndTax : 0,
    },
    contributions: {
      sss: summary.sss, philhealth: summary.philhealth, pagibig: summary.pagibig,
      basis: withSssLimits(d.contribution_basis, Number(rates.sss_msc_min) || 0, Number(rates.sss_msc_max) || 0),
      source: d.contribution_source || null,
    },
    taxable: taxable === null ? null : { amount: taxable, how: "The month's gross less absences and the employee's SSS, PhilHealth and Pag-IBIG (non-taxable items left out)" },
    tax: taxable === null ? null : {
      amount: summary.tax,
      bracket: same(summary.tax, d.withholding_tax) ? d.tax_bracket || null : null,
      table: data?.tax_table || [],
      period: "monthly",
    },
    year_end_tax: summary.yearEndTax > 0 ? summary.yearEndTax : 0,
    attendance: {
      absent: { amount: summary.amounts.absent, days: g("absences"), unit: unit.absent },
      late: { amount: summary.amounts.late, days: g("late"), minutes: info.pay?.counts?.late_minutes || 0, per_absent: Number(unit.late_days_per_absent) || 0, minute_pct: Number(unit.late_minute_pct) || 0 },
      undertime: { amount: summary.amounts.undertime, minutes: g("undertime"), hourly: unit.hourly },
      half_day: { amount: summary.amounts.half_day, days: g("halfDays"), unit: unit.half_day },
      lwop: { amount: summary.lwopDeduct, days: g("lwop"), daily: unit.daily },
      prior: ownHalf ? 0 : extras.priorAttendance || 0,
    },
    loans: loanLines,
    settlement: settling ? [
      ...(ownHalf ? [] : [{ key: "first_half_paid", label: extras.firstHalfStatus === "final" ? "Paid in 1st half" : "Paid in 1st half (not processed)", amount: extras.firstHalfPaid, how: `Net pay of the 1st cutoff payslip = ${pesoText(extras.firstHalfPaid)}` }]),
      { key: "carry_in", label: "Balance carried from last month", amount: extras.carryIn, how: "Last month's negative 2nd half, recovered here" },
    ] : [],
    overrides: formOverrides(info, form, computedForm),
  });
  if (!ownHalf || taxable === null) return result;
  // The tax basis: the whole month, the 1st cutoff's attendance as it deducted it.
  const a = summary.amounts;
  const attendance = toAmount(a.absent + a.late + a.undertime + a.half_day + summary.lwopDeduct + extras.priorAttendance);
  const contributions = toAmount(summary.sss + summary.philhealth + summary.pagibig);
  return {
    ...result,
    monthly_tax: {
      basic: summary.basic,
      // The month's taxable earnings beyond the salary (overload, incentives, the 1st cutoff's extras).
      earnings: toAmount(taxable + attendance + contributions - summary.basic),
      attendance,
      contributions,
      taxable,
      tax: summary.tax,
    },
    reconciliation: {
      first_half_net: extras.firstHalfPaid,
      second_half_net: summary.net,
      total: toAmount(extras.firstHalfPaid + summary.net),
      monthly_net: toAmount(summary.monthNet - extras.carryIn - summary.yearEndTax),
      estimate: extras.firstHalfStatus !== "final",
    },
  };
}

/** "₱32,000" for whole pesos, "₱1,471.26" otherwise. */
const pesoShort = (value) => pesoText(value).replace(/\.00$/, "");
const daysText = (n) => `${toAmount(n)} day${toAmount(n) === 1 ? "" : "s"}`;

/**
 * The Process Payroll summary, compact (2026-11-14): each line's text is its
 * formula only ("₱32,000 ÷ 2", "5 days × ₱1,471.26"), a ₱0 line shows none,
 * Late not charged keeps its explanation behind the tag (line.tip), and a
 * 1st half drops the "deducted on the 2nd half" group notes (the form says
 * it once). Same lines, tags, amounts and subtotals as previewLineGroups.
 */
export function compactLineGroups(result, { employee, form, summary }) {
  if (!result) return result;
  const unit = summary.info.unit || {};
  const d = summary.info.row?.defaults || {};
  const source = d.contribution_source || {};
  const basis = d.contribution_basis || {};
  const extras = summary.extras || {};
  const monthly = toAmount(employee?.basic_salary);
  const g = (key) => toAmount(form[key]);
  const formula = (l) => {
    if (l.tag === "not_charged") return null;
    if (!(l.amount > 0)) return null;
    switch (l.key) {
      case "basic":
        if (summary.settling && extras.perCutoff) return `${pesoShort(summary.basic)} − ${pesoShort(extras.firstHalfBasic)} (1st half)`;
        if (summary.settling) return `${pesoShort(summary.basic)} a month`;
        return same(l.amount, monthly / 2) ? `${pesoShort(monthly)} ÷ 2` : null;
      case "overtime": {
        const hours = Math.round(((summary.info.pay?.counts?.overtime_minutes || 0) / 60) * 100) / 100;
        const premium = Number(summary.info.rates?.overtime_premium_pct) || 0;
        return hours ? `${hours} h × ${pesoShort(unit.hourly)}${premium ? ` × ${100 + premium}%` : ""}` : null;
      }
      case "overload":
        return d.overload_hours ? `${toAmount(d.overload_hours)} h × ${pesoShort(l.amount / d.overload_hours)}` : null;
      case "early_bird": case "perfect": case "incentives": case "subsidy": return null;
      case "prior_earnings": case "prior_attendance": return "From the 1st cutoff payslip";
      case "sss": case "philhealth": case "pagibig": {
        if (source[l.key] === "fixed") return "Fixed monthly amount";
        if (source[l.key] === "employee") return "Set for this employee";
        const b = basis[l.key];
        if (!b || !Number.isFinite(Number(b.pct))) return null;
        const limit = /ceiling/.test(l.how) ? " (ceiling)" : /SSS minimum/.test(l.how) ? " (minimum)" : /floor/.test(l.how) ? " (floor)" : /capped/.test(l.how) ? " (cap)" : "";
        return `${Number(b.pct)}% × ${pesoShort(b.base)}${limit}`;
      }
      case "withholding_tax": {
        const e = result.tax;
        if (!e?.bracket) return null;
        return `${e.bracket.base > 0 ? `${pesoShort(e.bracket.base)} + ` : ""}${e.bracket.rate_pct}% × (${pesoShort(e.taxable)} − ${pesoShort(e.bracket.over)})`;
      }
      case "absent": return `${daysText(g("absences"))} × ${pesoShort(unit.absent)}`;
      case "undertime": return `${g("undertime")} min × ${pesoShort(unit.hourly)} ÷ 60`;
      case "half_day": return `${daysText(g("halfDays"))} × ${pesoShort(unit.half_day)}`;
      case "lwop": return `${daysText(g("lwop"))} × ${pesoShort(unit.daily)}`;
      case "first_half_paid": return "1st half net pay";
      default: return String(l.how || "").replace(/ = -?₱[\d,.]+$/, "") || null;
    }
  };
  const first = result.half === "first";
  return {
    ...result,
    taxable: result.taxable ? { ...result.taxable, how: null } : result.taxable,
    groups: result.groups.map((group) => ({
      ...group,
      note: first && (group.key === "contributions" || group.key === "tax") ? null : group.note,
      lines: group.lines.map((l) => ({
        ...l,
        how: formula(l),
        ...(l.tag === "not_charged" ? { tip: l.how } : {}),
        // A ₱0 tax still says why (exempt bracket / no taxable income).
        ...(l.key === "withholding_tax" && !(l.amount > 0) ? { how: /exempt/.test(result.tax?.reason || "") ? "Exempt bracket" : result.tax?.reason || null } : {}),
      })),
    })),
  };
}
