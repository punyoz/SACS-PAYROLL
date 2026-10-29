/**
 * Reads what BIR Form 2316 and the 1604-C alphalist need for a calendar year
 * (src/lib/payroll/bir-2316.js computes them). Server only.
 *
 *   loadBirYear(supabase, { year, branchId, employeeId })
 *     → { year, employer, employer_missing, ceiling, tax_table_ready, rows }
 *
 * One certificate per employee for the whole school: an employee who moved
 * branches has one 2316 with every branch's payslips. `branchId` limits the
 * list to employees whose branch is that one now (the Accountant's branch).
 *
 * Year-end tax annualization (2026-10-29, src/lib/payroll/year-end-tax.js):
 * the year-end adjustment lines on Final payslips (payroll.year_end_tax, by its
 * tax year, even on January of the next year) are part of the tax withheld.
 * Each row also keeps its `sources` (payslip figures, benefits, adjustments).
 *   employeeIds     several employees at once
 *   approvedOnly    false: every Final payslip, HR-approved or not (payroll
 *                   processing the adjustment); true (default): as the
 *                   employee sees them, the forms
 *   excludePeriod   leave out that period's payslips (the one being processed)
 *   details         false: no TIN, birth date (payroll needs only the figures)
 *
 *   loadYearEndTaxContext(supabase, employeeIds, period)
 *     → { ready, byEmployee: Map(employee_id → { record, year, prior, employee, ceiling, taxTable }) }
 *   the annualizations scheduled onto `period`, with what payroll needs to
 *   compute their adjustment.
 */

import { listUsersCached } from "@/lib/auth/users-cache";
import { fetchProfilesPii } from "@/lib/employees/pii";
import { birEmployerFrom, formatTin, missingBirEmployerFields } from "@/lib/payroll/bir-employer";
import { compute2316, DEFAULT_BENEFITS_CEILING, nameParts, payslipFigures, periodMonth, periodYear } from "@/lib/payroll/bir-2316";
import { resolveRate, loadRateConfigs } from "@/lib/payroll/rates";
import { payslipVisible } from "@/lib/payroll/runs";
import { resolveTaxTableRows, taxTableFromRows } from "@/lib/payroll/semi-monthly";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";

const ENTRY_COLUMNS = "id,employee_id,pay_period,status,run_id,totals:payroll->totals,deductions:payroll->deductions,"
  + "basic_earned:payroll->basic_earned,subsidy:payroll->subsidy,final_pay:payroll->final_pay";

// Payslips carrying a year-end tax adjustment (src/lib/payroll/year-end-tax.js).
const ADJUSTMENT_COLUMNS = "id,employee_id,pay_period,status,run_id,year_end_tax:payroll->year_end_tax";

const PROFILE_COLUMNS = "id,full_name,first_name,middle_name,last_name,suffix,employee_id,branch_id,position,address,cp_number,date_hired,separated_on,employee_status";

function check(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data || [];
}

/** The years with at least one paid payslip, newest first (for the year picker). */
export async function birYears(supabase, { employeeId = null } = {}) {
  const build = () => {
    let query = supabase.from("payroll_entries").select("pay_period").eq("status", "paid");
    if (employeeId) query = query.eq("employee_id", employeeId);
    return query.order("id", { ascending: true });
  };
  const rows = check(await fetchAllRows(build), "Payslips");
  const years = new Set();
  rows.forEach((row) => {
    const y = periodYear(row.pay_period);
    if (y) years.add(y);
  });
  return [...years].sort((a, b) => b - a);
}

export async function loadBirYear(supabase, { year, branchId = null, employeeId = null, employeeIds = null, approvedOnly = true, excludePeriod = null, details = true }) {
  const y = Number(year);
  const yearEnd = `${y}-12-31`;
  // One employee, several (fetched in chunks), or everyone.
  const many = Array.isArray(employeeIds) ? [...new Set(employeeIds.filter(Boolean))] : null;
  const fetchFor = (build) => (many ? fetchAllIn(build, "employee_id", many) : fetchAllRows(build));

  const entriesQuery = (pattern) => () => {
    let query = supabase.from("payroll_entries").select(ENTRY_COLUMNS).eq("status", "paid").like("pay_period", pattern);
    if (employeeId) query = query.eq("employee_id", employeeId);
    return query.order("id", { ascending: true });
  };
  const [regular, finals, benefitsResult, taxResult, { configs }, configResult, adjustmentResult] = await Promise.all([
    fetchFor(entriesQuery(`%, ${y}`)),
    fetchFor(entriesQuery("Final pay%")),
    fetchFor(() => {
      let query = supabase.from("payroll_exempt_benefits_paid").select("employee_id,kind,amount,paid_on").eq("tax_year", y);
      if (employeeId) query = query.eq("employee_id", employeeId);
      return query.order("employee_id", { ascending: true }).order("paid_on", { ascending: true });
    }),
    supabase.from("payroll_tax_brackets").select("version_id,effective_date,bracket_over,base_tax,rate_pct,created_at").lte("effective_date", yearEnd),
    loadRateConfigs(supabase),
    supabase.from("system_config").select("key,value").eq("section", "general"),
    fetchFor(() => {
      let query = supabase.from("payroll_entries").select(ADJUSTMENT_COLUMNS).eq("status", "paid").not("payroll->year_end_tax", "is", null);
      if (employeeId) query = query.eq("employee_id", employeeId);
      return query.order("id", { ascending: true });
    }),
  ]);

  // Regular payslips of the year, and final pays released in it.
  const yearEntries = check(regular, "Payslips").filter((entry) => periodYear(entry.pay_period) === y)
    .concat(check(finals, "Final pays").filter((entry) => String(entry.final_pay?.release_on || entry.final_pay?.separated_on || "").slice(0, 4) === String(y)))
    .filter((entry) => !excludePeriod || entry.pay_period !== excludePeriod);
  // Year-end tax adjustments for this tax year, wherever they were paid.
  const adjustmentEntries = check(adjustmentResult, "Year-end tax adjustments")
    .filter((entry) => Number(entry.year_end_tax?.tax_year) === y && Math.abs(Number(entry.year_end_tax?.signed) || 0) >= 0.01)
    .filter((entry) => !excludePeriod || entry.pay_period !== excludePeriod);
  // Only payslips HR approved (from October 2026, src/lib/payroll/runs.js), as the employee sees them.
  const runIds = [...new Set([...yearEntries, ...adjustmentEntries].map((e) => e.run_id).filter(Boolean))];
  const runs = runIds.length
    ? check(await fetchAllIn(() => supabase.from("payroll_runs").select("id,status").order("id", { ascending: true }), "id", runIds), "Payroll runs")
    : [];
  const approved = new Set(runs.filter((run) => run.status === "approved").map((run) => run.id));
  const visible = (entry) => !approvedOnly || payslipVisible(entry.pay_period, entry.run_id && approved.has(entry.run_id) ? "approved" : null);
  const entries = yearEntries.filter(visible);
  const adjustments = adjustmentEntries.filter(visible);
  const benefits = check(benefitsResult, "13th month and benefits");
  const taxTable = taxTableFromRows(resolveTaxTableRows(check(taxResult, "Tax table"), yearEnd));
  const ceilingRate = resolveRate(configs, "benefits_exempt_ceiling", {}, yearEnd);
  const ceiling = ceilingRate.source === "config" ? Number(ceilingRate.value) : DEFAULT_BENEFITS_CEILING;
  const employer = birEmployerFrom(Object.fromEntries(check(configResult, "Configuration").map((row) => [row.key, row.value])));

  const ids = [...new Set([...entries, ...benefits, ...adjustments].map((e) => e.employee_id).filter(Boolean))]
    .filter((id) => !many || many.includes(id));
  const profiles = check(await fetchAllIn(() => supabase.from("profiles").select(PROFILE_COLUMNS).order("id", { ascending: true }), "id", ids), "Employees")
    .filter((p) => !branchId || String(p.branch_id || "") === String(branchId));
  const inScope = profiles.map((p) => p.id);

  // A final pay's subsidy is taxed by its balance's treatment.
  const balanceIds = entries.map((e) => e.final_pay?.breakdown?.subsidy?.balance_id).filter(Boolean);
  const balances = balanceIds.length
    ? check(await fetchAllIn(() => supabase.from("payroll_subsidy_balances").select("id,tax_treatment").order("id", { ascending: true }), "id", balanceIds), "Subsidy balances")
    : [];
  const treatmentOf = new Map(balances.map((b) => [b.id, b.tax_treatment]));

  // details: false (payroll computing an adjustment) needs no TIN or birth date.
  const [pii, users, branches] = await Promise.all([
    details ? fetchProfilesPii(supabase, inScope) : new Map(),
    details ? listUsersCached(supabase) : { data: { users: [] } },
    supabase.from("branches").select("id,name"),
  ]);
  const birthOf = new Map((users.data?.users || []).map((u) => [u.id, String(u.user_metadata?.date_of_birth || "").slice(0, 10)]));
  const branchName = new Map((branches.data || []).map((b) => [b.id, b.name]));

  const entriesBy = new Map();
  entries.forEach((entry) => {
    const list = entriesBy.get(entry.employee_id) || [];
    list.push(entry);
    entriesBy.set(entry.employee_id, list);
  });
  const benefitsBy = new Map();
  benefits.forEach((row) => {
    const list = benefitsBy.get(row.employee_id) || [];
    list.push(row);
    benefitsBy.set(row.employee_id, list);
  });
  const adjustmentsBy = new Map();
  adjustments.forEach((entry) => {
    const list = adjustmentsBy.get(entry.employee_id) || [];
    list.push({ amount: Number(entry.year_end_tax.signed) || 0, pay_period: entry.pay_period, entry_id: entry.id });
    adjustmentsBy.set(entry.employee_id, list);
  });

  const rows = profiles.map((profile) => {
    const payslips = (entriesBy.get(profile.id) || []).map((entry) => {
      const payroll = { totals: entry.totals, deductions: entry.deductions, basic_earned: entry.basic_earned, subsidy: entry.subsidy, final_pay: entry.final_pay };
      const releasedOn = String(entry.final_pay?.release_on || "");
      return {
        pay_period: entry.pay_period,
        month: entry.final_pay ? Number(releasedOn.slice(5, 7)) || 12 : periodMonth(entry.pay_period),
        figures: payslipFigures({ payroll }, { subsidyTreatment: treatmentOf.get(entry.final_pay?.breakdown?.subsidy?.balance_id) || null }),
      };
    });
    const sources = { payslips, benefits: benefitsBy.get(profile.id) || [], adjustments: adjustmentsBy.get(profile.id) || [] };
    const form = compute2316({ year: y, employee: profile, ...sources, ceiling, taxTable });
    return {
      employee_id: profile.id,
      employee_code: profile.employee_id || "",
      full_name: profile.full_name || "",
      name: nameParts(profile),
      tin: formatTin(pii.get(profile.id)?.tin_number || ""),
      date_of_birth: birthOf.get(profile.id) || "",
      address: profile.address || "",
      contact: profile.cp_number || "",
      branch_name: branchName.get(profile.branch_id) || "",
      position: profile.position || "",
      employee_status: profile.employee_status || "",
      branch_id: profile.branch_id || null,
      employee: { date_hired: profile.date_hired || null, separated_on: profile.separated_on || null },
      form,
      sources,
    };
  }).sort((a, b) => `${a.name.last} ${a.name.first}`.localeCompare(`${b.name.last} ${b.name.first}`));

  return {
    year: y,
    employer,
    employer_missing: missingBirEmployerFields(employer),
    ceiling,
    tax_table_ready: taxTable.length > 0,
    tax_table: taxTable,
    rows,
  };
}

/**
 * The annualizations scheduled onto `period` (a 2nd cutoff) for these
 * employees, and each one's tax year without this payslip: every Final
 * payslip (approved or not), benefits and settled adjustments. `ready` is
 * false only when there is something scheduled and it could not be read;
 * before 20261029010000 there is nothing scheduled.
 */
export async function loadYearEndTaxContext(supabase, employeeIds, period) {
  const byEmployee = new Map();
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  if (!ids.length || !period?.label) return { ready: true, byEmployee };
  const scheduled = await fetchAllIn(() => supabase.from("payroll_tax_annualizations")
    .select("id,tax_year,employee_id,target_period,status,balance")
    .eq("status", "scheduled")
    .eq("target_period", period.label)
    .order("id", { ascending: true }), "employee_id", ids);
  // The table is not there yet (migration not applied): nothing is scheduled.
  if (scheduled.error) return { ready: true, byEmployee };
  const records = scheduled.data || [];
  if (!records.length) return { ready: true, byEmployee };

  try {
    const years = [...new Set(records.map((r) => Number(r.tax_year)))];
    for (const year of years) {
      const forYear = records.filter((r) => Number(r.tax_year) === year);
      const data = await loadBirYear(supabase, {
        year, employeeIds: forYear.map((r) => r.employee_id), approvedOnly: false, excludePeriod: period.label, details: false,
      });
      const rowOf = new Map(data.rows.map((row) => [row.employee_id, row]));
      forYear.forEach((record) => {
        const row = rowOf.get(record.employee_id);
        byEmployee.set(record.employee_id, {
          record,
          year,
          prior: row?.sources || { payslips: [], benefits: [], adjustments: [] },
          employee: row?.employee || {},
          ceiling: data.ceiling,
          taxTable: data.tax_table,
        });
      });
    }
  } catch {
    return { ready: false, byEmployee: new Map() };
  }
  return { ready: true, byEmployee };
}
