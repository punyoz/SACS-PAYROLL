/**
 * Every added and deducted payroll line with a type tag and a "how it was
 * computed" text (2026-11-03), grouped the way the Process Payroll summary,
 * the payslip and HR's approval view show them:
 *
 *   Additions                                     +
 *   Government contributions (employee share)     -   SSS, PhilHealth, Pag-IBIG
 *   Taxable income                                    (between the two groups)
 *   Withholding tax (income tax)                  -   TRAIN law, BIR table
 *   Attendance deductions                         -
 *   Loans / advances                              -
 *   Month settlement (2nd half preview)           -
 *
 * Tags: percentage (a % of a base), bracket (graduated tax), rate_units (a
 * rate x days / minutes / hours), fixed (an amount as approved or filed),
 * not_charged (recorded, ₱0 by policy).
 *
 * Nothing here computes pay. Every label is written from the amounts, rates
 * and bases the engine itself recorded (payroll.monthly.contribution_basis,
 * tax_bracket, taxable_income, audit.lines, audit.rates), or for the preview
 * from the figures the summary already shows, so a label cannot disagree with
 * its amount. Employer shares and EC are never here: they are the school's
 * cost, shown only in employer cost and remittance reports.
 */

import { roundPeso } from "@/lib/payroll/money";

export const LINE_TAGS = Object.freeze({
  percentage: Object.freeze({ label: "Percentage", hint: "A percentage of a base amount (salary credit, basic salary, hourly or daily rate)." }),
  bracket: Object.freeze({ label: "Graduated bracket", hint: "Income tax: a base tax plus a % of the income over the bracket's lower limit." }),
  rate_units: Object.freeze({ label: "Rate × units", hint: "Not a percentage: a peso rate times days, minutes or hours." }),
  fixed: Object.freeze({ label: "Fixed amount", hint: "Not a percentage: an amount as approved, filed or scheduled." }),
  not_charged: Object.freeze({ label: "Not charged", hint: "Recorded, but nothing is added or deducted under the current policy." }),
});

export const GROUP_TITLES = Object.freeze({
  additions: "Additions",
  contributions: "Government contributions (employee share)",
  tax: "Withholding tax (income tax)",
  attendance: "Attendance deductions",
  loans: "Loans / advances",
  settlement: "Month settlement",
});

export const DEFERRED_NOTE = "Deducted on the 2nd half of the month";

const peso = (value) => roundPeso(Number(value) || 0);
const num = (value) => Number(value) || 0;

/** "₱18,500.00". */
export function pesoText(value) {
  const amount = peso(value);
  return `${amount < 0 ? "-" : ""}₱${Math.abs(amount).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** "₱18,500" for whole pesos, "₱850.57" otherwise. */
function pesoShort(value) {
  const amount = peso(value);
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
const pct = (value) => `${Math.round(num(value) * 100) / 100}%`;
const plural = (n, word) => `${Math.round(num(n) * 100) / 100} ${word}${num(n) === 1 ? "" : "s"}`;

/* ── Withholding tax ─────────────────────────────────────────────────────── */

/** Rows { over, base, rate (fraction) | rate_pct } -> sorted { over, base, rate_pct }. */
export function normalizeTaxTable(table) {
  return [...(table || [])]
    .map((row) => ({
      over: num(row.over ?? row.bracket_over),
      base: num(row.base ?? row.base_tax),
      rate_pct: row.rate_pct !== undefined ? num(row.rate_pct) : Math.round(num(row.rate) * 10000) / 100,
    }))
    .sort((a, b) => a.over - b.over);
}

/** "₱20,833 to ₱33,332", "up to ₱20,833", "₱666,667 and above" for row i. */
export function bracketRangeText(rows, index) {
  const row = rows[index];
  const next = rows[index + 1];
  if (!row) return "";
  if (index === 0 && next) return `up to ${pesoShort(next.over)}`;
  if (!next) return `${pesoShort(row.over)} and above`;
  return `${pesoShort(row.over)} to ${pesoShort(next.over - 1)}`;
}

/** The index of the bracket the taxable income is in (income exactly at "over" stays below). */
export function bracketIndexFor(rows, taxable) {
  let index = 0;
  rows.forEach((row, i) => { if (num(taxable) > row.over) index = i; });
  return rows.length ? index : -1;
}

/**
 * "How was this tax computed?": taxable income, bracket, base tax, rate,
 * excess and the tax, from the bracket the engine recorded (or, for the
 * preview, the table it uses). A ₱0 tax says why.
 *
 * @param {object} args
 * @param {number} args.taxable   taxable income the tax was computed on
 * @param {number} args.tax       the withholding tax on the payslip
 * @param {object|null} [args.bracket]  { over, base, rate_pct } as recorded
 * @param {Array} [args.table]    the table in force (for the range and the highlight)
 * @param {boolean} [args.deferred]  a 1st half: deducted on the 2nd half
 */
export function taxExplanation({ taxable, tax, bracket = null, table = [], deferred = false, period = "monthly" }) {
  const rows = normalizeTaxTable(table);
  if (deferred) {
    return { deferred: true, tax: 0, reason: `${DEFERRED_NOTE}, on the whole month's taxable income.`, rows, index: -1 };
  }
  const income = Math.max(0, peso(taxable));
  let index = bracket ? rows.findIndex((row) => Math.abs(row.over - num(bracket.over)) < 0.005) : bracketIndexFor(rows, income);
  if (index < 0 && rows.length && !bracket) index = bracketIndexFor(rows, income);
  const used = bracket ? { over: num(bracket.over), base: num(bracket.base), rate_pct: num(bracket.rate_pct) } : rows[index] || null;
  const amount = peso(tax);
  const excess = used ? Math.max(0, peso(income - used.over)) : 0;
  const formula = used ? peso(used.base + excess * used.rate_pct / 100) : null;
  const range = index >= 0 ? bracketRangeText(rows, index) : used ? `over ${pesoShort(used.over)}` : "";
  const effective = income > 0 ? Math.round((amount / income) * 10000) / 100 : 0;
  const exemptTop = rows.length > 1 && rows[0].rate_pct === 0 ? rows[1].over : null;

  let reason = null;
  if (!(amount > 0)) {
    reason = !(income > 0)
      ? "No taxable income this month after the government contributions."
      : used && !(used.rate_pct > 0) && !(used.base > 0)
        ? `Taxable income ${pesoText(income)} is in the exempt bracket (${exemptTop ? `up to ${pesoShort(exemptTop)}` : range} a ${period === "monthly" ? "month" : "period"}), so no tax is withheld.`
        : "No tax was withheld on this payslip.";
  }
  return {
    deferred: false,
    taxable: income,
    tax: amount,
    bracket: used,
    range,
    index,
    rows,
    base_tax: used ? used.base : 0,
    rate_pct: used ? used.rate_pct : 0,
    excess,
    // The bracket formula in numbers; matches the tax unless it was recorded differently.
    formula_text: used
      ? `${pesoText(used.base)} + ${pct(used.rate_pct)} × (${pesoText(income)} − ${pesoText(used.over)}) = ${pesoText(formula)}`
      : null,
    matches: formula === null ? true : Math.abs(formula - amount) < 0.015,
    effective_pct: effective,
    reason,
    period,
  };
}

/** The tax line's own text: "15% of the excess over ₱20,833 (bracket ₱20,833 to ₱33,332) = ₱Y; 3.1% of taxable income". */
function taxHow(explain) {
  if (explain.deferred) return DEFERRED_NOTE;
  if (explain.reason) return explain.reason;
  const b = explain.bracket;
  if (!b) return `On taxable income ${pesoText(explain.taxable)} = ${pesoText(explain.tax)}`;
  const base = b.base > 0 ? `${pesoText(b.base)} + ` : "";
  return `${base}${pct(b.rate_pct)} of the excess over ${pesoShort(b.over)} (bracket ${explain.range}) = ${pesoText(explain.tax)}; ${pct(explain.effective_pct)} of taxable income`;
}

/* ── Contributions ───────────────────────────────────────────────────────── */

function contributionHow(name, amount, basis, source) {
  if (source === "fixed") return { tag: "fixed", how: `${name}: fixed monthly amount set by the school = ${pesoText(amount)}` };
  if (source === "employee") return { tag: "fixed", how: `${name}: amount set for this employee = ${pesoText(amount)}` };
  if (!basis || !Number.isFinite(Number(basis.pct))) return { tag: "fixed", how: `${name}: ${pesoText(amount)} (rate not recorded on this payslip)` };
  const base = pesoText(basis.base);
  const words = {
    "salary credit": "monthly salary credit",
    floor: "the PhilHealth floor; salary is below it",
    ceiling: "the PhilHealth ceiling; salary is above it",
    basic: "monthly basic salary",
    "fund salary cap": `capped at the ${base} fund salary`,
  }[basis.base_label] || basis.base_label || "base";
  if (name === "SSS" && basis.at_ceiling) return { tag: "percentage", how: `SSS: ${pct(basis.pct)} of ${base} (monthly salary credit, the SSS ceiling) = ${pesoText(amount)}` };
  if (name === "SSS" && basis.at_floor) return { tag: "percentage", how: `SSS: ${pct(basis.pct)} of ${base} (monthly salary credit, the SSS minimum) = ${pesoText(amount)}` };
  if (name === "Pag-IBIG" && basis.base_label === "fund salary cap") {
    return { tag: "percentage", how: `Pag-IBIG: ${pct(basis.pct)} of ${base}, capped at ${pesoText(peso(basis.base * basis.pct / 100))} = ${pesoText(amount)}` };
  }
  return { tag: "percentage", how: `${name}: ${pct(basis.pct)} of ${base} (${words}) = ${pesoText(amount)}` };
}

/* ── The builder ─────────────────────────────────────────────────────────── */

const line = (key, label, amount, sign, tag, how, extra = {}) => ({ key, label, amount: peso(amount), sign, tag, how, ...extra });

/**
 * @param {object} input  normalized figures (lineInputFromPayroll / the preview adapter)
 * @returns {{ half: string|null, groups: Array, taxable: object|null, tax: object }}
 */
export function buildLineGroups(input) {
  const half = input.half || null;
  const deferred = half === "first";
  const overrides = input.overrides || {};
  const mark = (key) => (overrides[key] ? { overridden: { reason: overrides[key].reason || null, from: overrides[key].from, to: overrides[key].to } } : {});
  const a = input.additions || {};
  const at = input.attendance || {};

  const additions = [];
  if (a.basic && num(a.basic.amount) > 0) {
    additions.push(line("basic", a.basic.label || "Basic pay", a.basic.amount, "+", "fixed", a.basic.how || `${pesoText(a.basic.amount)}`));
  }
  if (num(a.overtime?.amount) > 0) {
    const o = a.overtime;
    const factor = 100 + num(o.premium_pct);
    const hours = o.minutes ? Math.round((num(o.minutes) / 60) * 100) / 100 : null;
    additions.push(line("overtime", "Overtime (approved)", o.amount, "+", "percentage",
      `${factor}% of the hourly rate ${pesoText(o.hourly)}${hours !== null ? ` × ${plural(hours, "hour")}` : ""} = ${pesoText(o.amount)}${num(o.premium_pct) ? "" : " (overtime premium 0%)"}`));
  }
  if (num(a.holiday?.amount) > 0) {
    const parts = (a.holiday.lines || []).map((h) => `${h.name || "Holiday"}${h.pct ? `: +${pct(h.pct)} of the daily rate` : ""}${h.days ? ` × ${plural(h.days, "day")}` : ""} = ${pesoText(h.amount)}`);
    additions.push(line("holiday", "Holiday pay", a.holiday.amount, "+", "percentage",
      parts.length ? parts.join("; ") : `Holiday premium, a % of the daily rate${a.holiday.pct_text ? ` (${a.holiday.pct_text})` : ""} = ${pesoText(a.holiday.amount)}`));
  }
  if (num(a.early_bird?.amount) > 0) additions.push(line("early_bird", "Early Bird Incentive", a.early_bird.amount, "+", "fixed", `Fixed amount for the period's winner${a.early_bird.note ? ` (${a.early_bird.note})` : ""} = ${pesoText(a.early_bird.amount)}`));
  if (num(a.perfect?.amount) > 0) additions.push(line("perfect", "Perfect attendance", a.perfect.amount, "+", "fixed", `Fixed amount per period = ${pesoText(a.perfect.amount)}`, mark("perfect")));
  if (num(a.incentives?.amount) > 0) additions.push(line("incentives", a.incentives.label || "Approved incentives", a.incentives.amount, "+", "fixed", a.incentives.how || `As approved = ${pesoText(a.incentives.amount)}`));
  if (num(a.overload?.amount) > 0) {
    const o = a.overload;
    additions.push(line("overload", o.hours ? `Overload pay (${o.hours} h)` : "Overload pay", o.amount, "+", "rate_units",
      o.hours && o.rate ? `${plural(o.hours, "hour")} × ${pesoText(o.rate)}/hour = ${pesoText(o.amount)}` : `As filed = ${pesoText(o.amount)}`));
  }
  if (num(a.subsidy?.amount) > 0) additions.push(line("subsidy", "Licensed teacher subsidy", a.subsidy.amount, "+", "fixed", `Subsidy as approved = ${pesoText(a.subsidy.amount)}`));
  if (num(a.prior_earnings) > 0) additions.push(line("prior_earnings", "1st cutoff extra earnings (part of the month)", a.prior_earnings, "+", "fixed", `Already paid on the 1st cutoff payslip = ${pesoText(a.prior_earnings)}`));
  if (num(a.year_end_refund) > 0) additions.push(line("year_end_refund", "Year-end tax refund (over-withheld)", a.year_end_refund, "+", "fixed", "Annual tax due less the tax already withheld this year"));

  const c = input.contributions || {};
  const contributions = [];
  if (!deferred) {
    [["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"]].forEach(([key, name]) => {
      const amount = num(c[key]);
      if (!(amount > 0)) return;
      const { tag, how } = contributionHow(name, amount, c.basis?.[key], c.source?.[key]);
      contributions.push(line(key, name, amount, "-", tag, how));
    });
  }

  const taxInfo = taxExplanation({ taxable: input.taxable?.amount, tax: input.tax?.amount, bracket: input.tax?.bracket, table: input.tax?.table, deferred, period: input.tax?.period || "monthly" });
  const taxLines = [];
  if (!deferred && input.tax) {
    taxLines.push(line("withholding_tax", "Withholding tax", input.tax.amount, num(input.tax.amount) > 0 ? "-" : "0", "bracket", taxHow(taxInfo), { explanation: taxInfo }));
  }
  if (num(input.year_end_tax) > 0) taxLines.push(line("year_end_tax", "Year-end tax adjustment (under-withheld)", input.year_end_tax, "-", "fixed", "Annual tax due less the tax already withheld this year"));

  const attendance = [];
  if (num(at.absent?.amount) > 0) {
    const unit = at.absent.unit || (num(at.absent.days) ? at.absent.amount / at.absent.days : 0);
    attendance.push(line("absent", "Absences", at.absent.amount, "-", "rate_units", `${plural(at.absent.days, "day")} × ${pesoText(unit)}/day = ${pesoText(at.absent.amount)}`, mark("absent")));
  } else if (overrides.absent) attendance.push(line("absent", "Absences", 0, "0", "rate_units", `${plural(at.absent?.days || 0, "day")} = ${pesoText(0)}`, mark("absent")));
  if (at.late && (num(at.late.amount) > 0 || num(at.late.days) > 0 || num(at.late.minutes) > 0 || overrides.late)) {
    const charged = num(at.late.amount) > 0;
    const rule = at.late.per_absent > 0 ? `every ${at.late.per_absent} late days = 1 absence` : "";
    const minuteRule = at.late.minute_pct > 0 ? `${pct(at.late.minute_pct)} of the hourly rate per minute` : "";
    attendance.push(charged
      ? line("late", `Late (${plural(at.late.days, "day")})`, at.late.amount, "-", "rate_units", `${[rule, minuteRule].filter(Boolean).join(" + ")} = ${pesoText(at.late.amount)}`, mark("late"))
      : line("late", `Late (${plural(at.late.days || 0, "day")}, ${at.late.minutes || 0} min)`, 0, "0", "not_charged",
        rule || minuteRule ? `Below the charge rule (${[rule, minuteRule].filter(Boolean).join(" + ")}): recorded, nothing deducted` : "Late charge 0% under the current policy: recorded, not deducted", mark("late")));
  }
  if (num(at.undertime?.amount) > 0 || overrides.undertime) {
    attendance.push(line("undertime", "Undertime", at.undertime?.amount, num(at.undertime?.amount) > 0 ? "-" : "0", "rate_units",
      `${plural(at.undertime?.minutes || 0, "minute")} × ${pesoText(at.undertime?.hourly)}/hour ÷ 60 = ${pesoText(at.undertime?.amount)}`, mark("undertime")));
  }
  if (num(at.half_day?.amount) > 0 || overrides.half_day) {
    const unit = at.half_day?.unit || (num(at.half_day?.days) ? at.half_day.amount / at.half_day.days : 0);
    attendance.push(line("half_day", "Half day", at.half_day?.amount, num(at.half_day?.amount) > 0 ? "-" : "0", "rate_units", `${plural(at.half_day?.days || 0, "day")} × ${pesoText(unit)}/half day = ${pesoText(at.half_day?.amount)}`, mark("half_day")));
  }
  if (num(at.lwop?.amount) > 0) {
    attendance.push(line("lwop", "Leave without pay", at.lwop.amount, "-", "rate_units", `${plural(at.lwop.days, "day")} × ${pesoText(at.lwop.daily)}/day = ${pesoText(at.lwop.amount)}`, mark("lwop")));
  }
  if (num(at.prior) > 0) attendance.push(line("prior_attendance", "1st cutoff attendance (already deducted there)", at.prior, "-", "fixed", `As on the 1st cutoff payslip = ${pesoText(at.prior)}`));

  const loans = (input.loans || []).filter((l) => num(l.amount) > 0)
    .map((l, i) => line(`${l.kind || "loan"}-${i}`, l.label, l.amount, "-", "fixed", l.how || `Installment = ${pesoText(l.amount)}`));

  const settlement = (input.settlement || []).filter((s) => num(s.amount) > 0)
    .map((s) => line(s.key, s.label, s.amount, "-", "fixed", s.how));

  const sum = (lines) => peso(lines.reduce((total, l) => total + (l.sign === "-" ? l.amount : l.sign === "+" ? l.amount : 0), 0));
  const groups = [
    { key: "additions", title: GROUP_TITLES.additions, sign: "+", lines: additions, subtotal: sum(additions) },
    {
      key: "contributions", title: GROUP_TITLES.contributions, sign: "-", lines: contributions, subtotal: sum(contributions),
      note: deferred ? DEFERRED_NOTE : contributions.length ? null : "None on this payslip",
    },
    {
      key: "tax", title: GROUP_TITLES.tax, sign: "-", lines: taxLines, subtotal: sum(taxLines),
      note: deferred ? DEFERRED_NOTE : null,
    },
    { key: "attendance", title: GROUP_TITLES.attendance, sign: "-", lines: attendance, subtotal: sum(attendance) },
    { key: "loans", title: GROUP_TITLES.loans, sign: "-", lines: loans, subtotal: sum(loans) },
    ...(settlement.length ? [{ key: "settlement", title: GROUP_TITLES.settlement, sign: "-", lines: settlement, subtotal: sum(settlement) }] : []),
  ];

  const taxable = !deferred && input.taxable && input.taxable.amount !== undefined && input.taxable.amount !== null
    ? {
      amount: peso(input.taxable.amount),
      how: input.taxable.how || `Gross less the employee's contributions (${pesoText(sum(contributions))}), non-taxable items left out`,
    }
    : null;

  return { half, groups, taxable, tax: taxInfo };
}

/** Additions less every deduction group: what the lines add up to. */
export function linesNet(result) {
  return peso((result?.groups || []).reduce((total, g) => total + (g.sign === "+" ? g.subtotal : -g.subtotal), 0));
}

/* ── Adapter: a stored payslip (payroll_entries.payroll) ────────────────── */

const OVERRIDE_KEYS = { absences_days: "absent", late_days: "late", undertime_minutes: "undertime", half_days: "half_day", leave_without_pay_days: "lwop", perfect_attendance: "perfect" };

/** Deviation items + reason -> { absent: { reason, from, to }, … }. */
export function overridesFromDeviations(deviations) {
  const out = {};
  (deviations?.items || []).forEach((item) => {
    const key = OVERRIDE_KEYS[item.field];
    if (key) out[key] = { reason: deviations.reason || null, from: item.default, to: item.value };
  });
  return out;
}

/** Marks an SSS salary credit at the SSS minimum or maximum (the label says so). */
export function withSssLimits(basis, min, max) {
  if (!basis?.sss) return basis || {};
  const base = num(basis.sss.base);
  return { ...basis, sss: { ...basis.sss, at_ceiling: max > 0 && base >= max, at_floor: min > 0 && base <= min } };
}

const holidayPct = (note) => {
  const match = /\+([\d.]+)% of daily rate/.exec(String(note || ""));
  return match ? Number(match[1]) : null;
};
const holidayName = (note) => {
  const text = String(note || "");
  return text.split(" · ")[0] || "Holiday";
};

/**
 * The normalized input for buildLineGroups from a stored per-cutoff payslip
 * (payroll.monthly.cutoff). null for a payslip without that breakdown (an
 * older one): those keep their own rendering.
 */
export function lineInputFromPayroll(payroll, { taxTable = [] } = {}) {
  const m = payroll?.monthly;
  const cutoff = m?.cutoff;
  if (!cutoff || !Array.isArray(cutoff.earnings) || !Array.isArray(cutoff.deductions)) return null;
  const t = payroll.totals || {};
  const d = payroll.deductions || {};
  const rates = payroll.audit?.rates || {};
  const rate = (type) => num(rates[type]?.value);
  const lines = payroll.audit?.lines || {};
  const firstOf = (list, type) => (list || []).find((l) => l.type === type && !l.is_override && num(l.rate) > 0) || null;
  const basicLine = cutoff.earnings.find((l) => /^Basic pay/.test(l.label)) || null;
  const overtimeLines = (lines.incentives || []).filter((l) => l.type === "overtime");
  const holidayLines = (lines.incentives || []).filter((l) => l.type === "holiday_premium" && num(l.amount) > 0);
  const overloadLine = (lines.incentives || []).find((l) => l.type === "overload") || null;
  const loanLines = (payroll.loans || []).filter((l) => num(l.amount) > 0);
  const offset = peso(num(d.loan) - loanLines.reduce((s, l) => s + num(l.amount), 0));
  const source = payroll.audit?.school_sheet?.contribution_source || m.contribution_source || null;
  const yearEnd = payroll.year_end_tax && num(payroll.year_end_tax.amount) > 0 ? payroll.year_end_tax : null;
  const second = cutoff.half === "second";

  return {
    half: cutoff.half,
    additions: {
      basic: basicLine ? {
        label: basicLine.label, amount: basicLine.amount,
        how: m.monthly_salary && /÷ 2/.test(basicLine.note || "")
          ? `Monthly salary ${pesoText(m.monthly_salary)} ÷ 2 = ${pesoText(basicLine.amount)}`
          : `${basicLine.note || "Basic pay"} = ${pesoText(basicLine.amount)}`,
      } : null,
      overtime: {
        amount: t.overtime_pay,
        minutes: overtimeLines.reduce((s, l) => s + num(l.quantity), 0),
        // The line's rate is the overtime hourly rate (hourly × (100% + premium)).
        hourly: overtimeLines[0] ? peso(num(overtimeLines[0].rate) / (1 + rate("overtime_premium_pct") / 100)) : rate("hourly"),
        premium_pct: rate("overtime_premium_pct"),
      },
      holiday: {
        amount: t.holiday_pay,
        lines: holidayLines.map((l) => ({ name: holidayName(l.note), pct: holidayPct(l.note), days: num(l.quantity), amount: l.amount })),
      },
      early_bird: { amount: t.early_bird_winner_incentive, note: payroll.early_bird ? `${payroll.early_bird.early_count} early time-ins` : null },
      perfect: { amount: t.perfect_attendance_incentive },
      incentives: { amount: t.other_incentive },
      overload: { amount: t.overload_pay, hours: m.overload_hours || (overloadLine ? num(overloadLine.quantity) : null), rate: overloadLine ? num(overloadLine.rate) : null },
      subsidy: { amount: t.subsidy_pay },
      year_end_refund: yearEnd?.kind === "refund" ? yearEnd.amount : 0,
    },
    contributions: second ? { sss: d.sss, philhealth: d.philhealth, pagibig: d.pagibig, basis: withSssLimits(m.contribution_basis, rate("sss_msc_min"), rate("sss_msc_max")), source } : {},
    taxable: second && m.taxable_income !== undefined ? { amount: m.taxable_income, how: "The whole month's gross less the employee's SSS, PhilHealth and Pag-IBIG (non-taxable items left out)" } : null,
    tax: second ? { amount: d.withholding_tax, bracket: m.tax_bracket || null, table: taxTable, period: "monthly" } : null,
    year_end_tax: yearEnd && yearEnd.kind !== "refund" ? yearEnd.amount : 0,
    attendance: {
      absent: { amount: t.absence_deduction, days: d.absences_days, unit: num(firstOf(lines.deductions, "absent")?.rate) || null },
      late: { amount: t.late_deduction, days: d.late_days, minutes: d.late_minutes, per_absent: rate("late_days_per_absent"), minute_pct: rate("late_minute_charge_pct") },
      undertime: { amount: t.undertime_deduction, minutes: d.undertime_minutes, hourly: num(firstOf(lines.deductions, "undertime")?.rate) || rate("hourly") },
      half_day: { amount: t.half_day_deduction, days: d.half_days, unit: num(firstOf(lines.deductions, "half_day")?.rate) || null },
      lwop: { amount: t.leave_without_pay_deduction, days: d.leave_without_pay_days, daily: num(firstOf(lines.deductions, "leave_without_pay")?.rate) || rate("daily") },
    },
    loans: second ? [
      ...loanLines.map((l) => ({ kind: "loan", label: l.description || "Loan", amount: l.amount, how: `Installment ${pesoText(l.amortization || l.amount)}; balance ${pesoText(l.balance_before)} → ${pesoText(l.balance_after)}${num(l.shortfall) > 0 ? " (partial)" : ""}` })),
      ...(offset > 0 ? [{ kind: "offset", label: "Subsidy advance offset", amount: offset, how: "Prior-year subsidy advance recovered as approved" }] : []),
      ...(payroll.cash_advances || []).filter((l) => num(l.amount) > 0).map((l) => ({ kind: "cash_advance", label: l.description ? `Cash advance: ${l.description}` : "Cash advance", amount: l.amount, how: `Installment ${pesoText(l.amount)}; balance ${pesoText(l.balance_before)} → ${pesoText(l.balance_after)}` })),
      ...(num(m.carry_in) > 0 ? [{ kind: "carry", label: `Balance carried from ${m.carry_from || "last month"}`, amount: m.carry_in, how: "Last month's negative 2nd half, recovered here" }] : []),
    ] : [],
    overrides: overridesFromDeviations(payroll.audit?.deviations),
  };
}

/**
 * The grouped, tagged lines of a stored payslip, or null when its stored
 * figures do not support them (an older payslip, or lines that do not add up
 * to its own gross and deductions): the screen then keeps its old layout.
 * Never recomputes anything.
 */
export function payrollLineGroups(payroll, options = {}) {
  const input = lineInputFromPayroll(payroll, options);
  if (!input) return null;
  const result = buildLineGroups(input);
  const cutoff = payroll.monthly.cutoff;
  // A year-end refund is a credit among the payslip's deductions; here it is an addition.
  const refund = num(input.additions.year_end_refund);
  const additions = result.groups.find((g) => g.key === "additions").subtotal;
  const deductions = peso(result.groups.filter((g) => g.sign === "-").reduce((s, g) => s + g.subtotal, 0));
  const grossOk = Math.abs(additions - peso(num(cutoff.gross_pay) + refund)) < 0.015;
  const deductionsOk = Math.abs(deductions - peso(num(cutoff.total_deductions) + refund)) < 0.015;
  if (!grossOk || !deductionsOk) return null;
  return {
    ...result,
    gross: peso(cutoff.gross_pay),
    total_deductions: peso(cutoff.total_deductions),
    net: peso(cutoff.net_pay ?? payroll.totals?.net_pay),
    // Shown as before: what a short payslip carries to next month, and paid leave.
    carry_over_out: peso(cutoff.carry_over_out || 0),
    leave_with_pay_days: num(cutoff.leave_with_pay_days),
  };
}
