/**
 * Licensed Teacher Annual Subsidy on the 2nd-half payslip
 * (docs/payroll-schedule-loans-awol.md §6; payroll_subsidy_balances,
 * payroll_subsidy_adjustments, payroll_exempt_benefits_paid, 20261009010000).
 *
 *   Payout month (the balance's payout_period_start = this period):
 *     Subsidy earning        = entitlement − advances − carried in − already paid − forfeited
 *     This year's advances   closed by a 'subsidy_offset' (never from salary)
 *     Prior-year excess      an excess advance the Admin approved to "offset
 *                            against next year's subsidy" is taken here, as its
 *                            own deduction line, up to the payout
 *   Any 2nd half:
 *     Approved missed-month adjustments   earning, paid once
 *     Advances released this month        memo only (already paid in cash)
 *
 *   Tax (the balance's tax_treatment, decision 10):
 *     exempt          never taxed
 *     taxable         the payout and adjustments are taxable; an advance is
 *                     taxable in the month it is released
 *     other_benefit   13th month + subsidy (advances, payouts, adjustments)
 *                     paid in the calendar year share the exempt ceiling
 *                     (benefits_exempt_ceiling, default ₱90,000): only the
 *                     part above it is taxable, minus what earlier payslips
 *                     of the year already taxed (payroll.benefits_excess_taxed)
 */

import { roundPeso } from "@/lib/payroll/money";

const peso = (value) => roundPeso(value);
export const DEFAULT_BENEFITS_CEILING = 90000;

function isMissingRelation(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("pgrst205") || text.includes("does not exist")
    || text.includes("could not find the table") || text.includes("schema cache");
}

/**
 * What one employee's 2nd-half payslip for `period` pays and taxes for the subsidy.
 * @param {object} ctx  loadSubsidyContext()'s entry for the employee
 * @param {{ start_key: string, end_key: string }} period
 * @param {number} ceiling  benefits_exempt_ceiling in force
 */
export function subsidyForPayslip(ctx, period, ceiling = DEFAULT_BENEFITS_CEILING) {
  const empty = { payout: 0, adjustments_total: 0, prior_offset: 0, earnings_total: 0, taxable: 0, non_taxable: 0, extra_taxable: 0,
    earnings: [], deductions: [], memos: [], loan_payments: [], settlement: null, adjustment_ids: [], benefits_excess_taxed: 0 };
  if (!ctx) return empty;

  const balance = ctx.balance && ctx.balance.payout_period_start === period.start_key ? ctx.balance : null;
  const treatment = balance?.tax_treatment || ctx.adjustments?.[0]?.tax_treatment || ctx.memo_advances?.[0]?.tax_treatment || "other_benefit";
  const year = String(period.end_key).slice(0, 4);

  // Payout: what is left of this year's entitlement.
  let payout = 0;
  const loanPayments = [];
  const deductions = [];
  const earnings = [];
  if (balance) {
    const left = peso(Number(balance.entitlement) - Number(balance.advances_total) - Number(balance.carried_in || 0)
      - Number(balance.forfeited || 0) - (balance.status === "paid_out" ? 0 : Number(balance.paid_out || 0)));
    payout = Math.max(0, left);
    // This year's advances are settled by the subsidy itself.
    (ctx.advances || []).filter((loan) => Number(loan.remaining_balance) > 0 && loan.status !== "paid").forEach((loan) => {
      loanPayments.push({ loan_id: loan.id, kind: "subsidy_offset", amount: peso(loan.remaining_balance), amount_due: peso(loan.remaining_balance) });
    });
    if (payout > 0 || balance.entitlement > 0) {
      earnings.push({
        type: "subsidy", quantity: balance.eligible_months, unit: "month", rate: peso(Number(balance.annual_amount) / 12),
        amount: payout, note: `Licensed teacher subsidy ${String(balance.subsidy_year_start).slice(0, 4)}: ${peso(balance.entitlement).toFixed(2)}`
          + (Number(balance.advances_total) > 0 ? ` − advances ${peso(balance.advances_total).toFixed(2)}` : "")
          + (Number(balance.carried_in) > 0 ? ` − carried ${peso(balance.carried_in).toFixed(2)}` : ""),
      });
    }
  }

  // Prior-year excess advances approved for offset against this subsidy.
  let priorOffset = 0;
  if (payout > 0) {
    (ctx.prior_offsets || []).forEach((loan) => {
      const room = peso(payout - priorOffset);
      const amount = Math.min(peso(loan.remaining_balance), room);
      if (amount <= 0) return;
      priorOffset = peso(priorOffset + amount);
      loanPayments.push({ loan_id: loan.id, kind: "subsidy_offset", amount, amount_due: peso(loan.remaining_balance) });
      deductions.push({ type: "loan", quantity: 1, unit: "offset", rate: null, amount, note: "Prior-year excess subsidy advance, offset against this year's subsidy (approved)" });
    });
  }

  // Approved missed-month adjustments.
  const adjustments = ctx.adjustments || [];
  adjustments.forEach((adj) => {
    earnings.push({ type: "subsidy_adjustment", quantity: adj.months_missed, unit: "month", rate: null, amount: peso(adj.amount),
      note: `Licensed teacher subsidy — adjustment (${adj.months_label}), approved by ${adj.decided_by_name || "Admin"}` });
  });
  const adjustmentsTotal = peso(adjustments.reduce((sum, adj) => sum + Number(adj.amount || 0), 0));

  // Advances released this payroll month: memo only.
  const memos = (ctx.memo_advances || []).map((loan) => ({
    kind: "subsidy_advance", date: loan.date_granted, amount: peso(loan.principal),
    text: `Subsidy advance released ${loan.date_granted}: ${peso(loan.principal).toFixed(2)} — not deducted from salary`,
  }));

  const earningsTotal = peso(payout + adjustmentsTotal);
  let taxable = 0;
  let extraTaxable = 0;
  let excessTaxed = 0;
  if (treatment === "taxable") {
    taxable = earningsTotal;
    extraTaxable = peso(memos.reduce((sum, m) => sum + m.amount, 0));
  } else if (treatment === "other_benefit" && earningsTotal > 0) {
    const before = peso(ctx.benefits_ytd || 0);          // paid this year before this payslip (13th month, advances, payouts)
    const over = Math.max(0, peso(before + earningsTotal - ceiling));
    excessTaxed = Math.max(0, peso(over - Number(ctx.excess_taxed_ytd || 0)));
    taxable = Math.min(earningsTotal, excessTaxed);
  }

  return {
    payout,
    adjustments_total: adjustmentsTotal,
    prior_offset: priorOffset,
    earnings_total: earningsTotal,
    taxable: peso(taxable),
    non_taxable: peso(earningsTotal - taxable),
    extra_taxable: extraTaxable,
    earnings,
    deductions,
    memos,
    loan_payments: loanPayments,
    settlement: balance ? { balance_id: balance.id, payout, paid_on: period.end_key } : null,
    adjustment_ids: adjustments.map((adj) => adj.id),
    benefits_excess_taxed: peso(excessTaxed),
    tax_treatment: treatment,
    tax_year: year,
  };
}

/**
 * Per employee, everything subsidyForPayslip needs for a 2nd-half `period`.
 * Map employee id -> ctx; empty before 20261009010000.
 */
export async function loadSubsidyContext(supabase, employeeIds, period) {
  const byEmployee = new Map();
  if (!employeeIds.length || String(period?.start_key || "").slice(8, 10) !== "16") return { ready: true, byEmployee };
  const monthStart = `${String(period.start_key).slice(0, 7)}-01`;
  const year = String(period.end_key).slice(0, 4);

  const balances = await supabase.from("payroll_subsidy_balances").select("*")
    .in("employee_id", employeeIds).eq("payout_period_start", period.start_key);
  if (balances.error) {
    if (isMissingRelation(balances.error)) return { ready: true, byEmployee };
    return { ready: false, byEmployee };
  }
  const [loans, adjustments, benefits] = await Promise.all([
    supabase.from("payroll_loans").select("*").in("employee_id", employeeIds).eq("loan_type", "subsidy_advance"),
    supabase.from("payroll_subsidy_adjustments").select("*").in("employee_id", employeeIds).eq("status", "approved"),
    supabase.from("payroll_exempt_benefits_paid").select("employee_id,tax_year,kind,amount,paid_on").in("employee_id", employeeIds).eq("tax_year", Number(year)),
  ]);
  if (loans.error || adjustments.error || benefits.error) return { ready: false, byEmployee };

  const balanceTreatment = new Map();
  const allBalances = new Map();
  const balanceIds = [...new Set([...(loans.data || []), ...(adjustments.data || [])].map((r) => r.subsidy_balance_id).filter(Boolean))];
  if (balanceIds.length) {
    const rows = await supabase.from("payroll_subsidy_balances").select("id,tax_treatment,subsidy_year_start,status").in("id", balanceIds);
    (rows.data || []).forEach((row) => { balanceTreatment.set(row.id, row.tax_treatment); allBalances.set(row.id, row); });
  }

  employeeIds.forEach((id) => {
    const balance = (balances.data || []).find((b) => b.employee_id === id && ["open", "paid_out"].includes(b.status)) || null;
    const mine = (loans.data || []).filter((loan) => loan.employee_id === id);
    const advances = balance ? mine.filter((loan) => loan.subsidy_balance_id === balance.id) : [];
    const priorOffsets = mine.filter((loan) => loan.subsidy_balance_id !== balance?.id && loan.awaiting_decision
      && loan.decision === "offset_next_subsidy" && loan.decision_approved_at && Number(loan.remaining_balance) > 0)
      .sort((a, b) => String(a.date_granted).localeCompare(String(b.date_granted)));
    const memoAdvances = mine.filter((loan) => String(loan.date_granted) >= monthStart && String(loan.date_granted) <= period.end_key)
      .map((loan) => ({ ...loan, tax_treatment: balanceTreatment.get(loan.subsidy_balance_id) || "other_benefit" }));
    const approved = (adjustments.data || []).filter((adj) => adj.employee_id === id)
      .map((adj) => ({ ...adj, tax_treatment: balanceTreatment.get(adj.subsidy_balance_id) || "other_benefit" }));
    // Benefits already paid this tax year, without this period's own payout (a regenerated payslip).
    let benefitsYtd = peso((benefits.data || []).filter((row) => row.employee_id === id).reduce((sum, row) => sum + Number(row.amount || 0), 0));
    if (balance?.status === "paid_out" && balance.paid_out_on && String(balance.paid_out_on).slice(0, 4) === year) {
      benefitsYtd = peso(benefitsYtd - Number(balance.paid_out || 0));
    }
    if (!balance && !approved.length && !memoAdvances.length && !priorOffsets.length) return;
    byEmployee.set(id, {
      balance, advances, prior_offsets: priorOffsets, memo_advances: memoAdvances, adjustments: approved,
      benefits_ytd: benefitsYtd, excess_taxed_ytd: 0,
    });
  });

  // Excess already taxed on this year's earlier payslips.
  const withSubsidy = [...byEmployee.keys()];
  if (withSubsidy.length) {
    const entries = await supabase.from("payroll_entries").select("employee_id,pay_period,status,payroll")
      .in("employee_id", withSubsidy).eq("status", "paid");
    (entries.data || []).forEach((entry) => {
      if (!String(entry.pay_period || "").endsWith(year) || entry.pay_period === period.label) return;
      const taxed = Number(entry.payroll?.benefits_excess_taxed || 0);
      if (taxed > 0) byEmployee.get(entry.employee_id).excess_taxed_ytd = peso(byEmployee.get(entry.employee_id).excess_taxed_ytd + taxed);
    });
  }
  return { ready: true, byEmployee };
}
