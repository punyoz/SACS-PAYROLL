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

export async function loadBirYear(supabase, { year, branchId = null, employeeId = null }) {
  const y = Number(year);
  const yearEnd = `${y}-12-31`;

  const entriesQuery = (pattern) => () => {
    let query = supabase.from("payroll_entries").select(ENTRY_COLUMNS).eq("status", "paid").like("pay_period", pattern);
    if (employeeId) query = query.eq("employee_id", employeeId);
    return query.order("id", { ascending: true });
  };
  const [regular, finals, benefitsResult, taxResult, { configs }, configResult] = await Promise.all([
    fetchAllRows(entriesQuery(`%, ${y}`)),
    fetchAllRows(entriesQuery("Final pay%")),
    fetchAllRows(() => {
      let query = supabase.from("payroll_exempt_benefits_paid").select("employee_id,kind,amount,paid_on").eq("tax_year", y);
      if (employeeId) query = query.eq("employee_id", employeeId);
      return query.order("employee_id", { ascending: true }).order("paid_on", { ascending: true });
    }),
    supabase.from("payroll_tax_brackets").select("version_id,effective_date,bracket_over,base_tax,rate_pct,created_at").lte("effective_date", yearEnd),
    loadRateConfigs(supabase),
    supabase.from("system_config").select("key,value").eq("section", "general"),
  ]);

  // Regular payslips of the year, and final pays released in it.
  const yearEntries = check(regular, "Payslips").filter((entry) => periodYear(entry.pay_period) === y)
    .concat(check(finals, "Final pays").filter((entry) => String(entry.final_pay?.release_on || entry.final_pay?.separated_on || "").slice(0, 4) === String(y)));
  // Only payslips HR approved (from October 2026, src/lib/payroll/runs.js), as the employee sees them.
  const runIds = [...new Set(yearEntries.map((e) => e.run_id).filter(Boolean))];
  const runs = runIds.length
    ? check(await fetchAllIn(() => supabase.from("payroll_runs").select("id,status").order("id", { ascending: true }), "id", runIds), "Payroll runs")
    : [];
  const approved = new Set(runs.filter((run) => run.status === "approved").map((run) => run.id));
  const entries = yearEntries.filter((entry) => payslipVisible(entry.pay_period, entry.run_id && approved.has(entry.run_id) ? "approved" : null));
  const benefits = check(benefitsResult, "13th month and benefits");
  const taxTable = taxTableFromRows(resolveTaxTableRows(check(taxResult, "Tax table"), yearEnd));
  const ceilingRate = resolveRate(configs, "benefits_exempt_ceiling", {}, yearEnd);
  const ceiling = ceilingRate.source === "config" ? Number(ceilingRate.value) : DEFAULT_BENEFITS_CEILING;
  const employer = birEmployerFrom(Object.fromEntries(check(configResult, "Configuration").map((row) => [row.key, row.value])));

  const ids = [...new Set([...entries.map((e) => e.employee_id), ...benefits.map((b) => b.employee_id)].filter(Boolean))];
  const profiles = check(await fetchAllIn(() => supabase.from("profiles").select(PROFILE_COLUMNS).order("id", { ascending: true }), "id", ids), "Employees")
    .filter((p) => !branchId || String(p.branch_id || "") === String(branchId));
  const inScope = profiles.map((p) => p.id);

  // A final pay's subsidy is taxed by its balance's treatment.
  const balanceIds = entries.map((e) => e.final_pay?.breakdown?.subsidy?.balance_id).filter(Boolean);
  const balances = balanceIds.length
    ? check(await fetchAllIn(() => supabase.from("payroll_subsidy_balances").select("id,tax_treatment").order("id", { ascending: true }), "id", balanceIds), "Subsidy balances")
    : [];
  const treatmentOf = new Map(balances.map((b) => [b.id, b.tax_treatment]));

  const [pii, users, branches] = await Promise.all([
    fetchProfilesPii(supabase, inScope),
    listUsersCached(supabase),
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
    const form = compute2316({ year: y, employee: profile, payslips, benefits: benefitsBy.get(profile.id) || [], ceiling, taxTable });
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
      form,
    };
  }).sort((a, b) => `${a.name.last} ${a.name.first}`.localeCompare(`${b.name.last} ${b.name.first}`));

  return {
    year: y,
    employer,
    employer_missing: missingBirEmployerFields(employer),
    ceiling,
    tax_table_ready: taxTable.length > 0,
    rows,
  };
}
