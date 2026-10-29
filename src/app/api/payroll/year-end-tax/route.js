/**
 * Year-end tax annualization (2026-10-29, src/lib/payroll/year-end-tax.js).
 * The Accountant only, its own branch (src/lib/payroll/bir-access.js); HR,
 * Admin and Super Admin are refused. The database functions of
 * 20261029010000_tax_annualization.sql check the role and the branch again.
 *
 *   GET  ?year=YYYY                          the year's annualizations, with
 *                                            the payslips that carry their adjustment
 *   POST { action: "run", year }             annualize every employee of the
 *                                            branch with payslips in that year
 *                                            (again: updates the records in place)
 *        { action: "schedule", id, period }  put the adjustment on that 2nd cutoff
 *        { action: "unschedule", id }
 *
 * Nothing here changes a payslip: the scheduled payslip computes and carries
 * the adjustment when the Accountant processes it.
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { normalizeText } from "@/lib/auth/normalize";
import { appendAuditLog } from "@/lib/audit/store";
import { birBranchScope, describeYearEndError, requireBirAccountant } from "@/lib/payroll/bir-access";
import { birYears, loadBirYear } from "@/lib/payroll/bir-forms";
import { manilaDateKey } from "@/lib/payroll/periods";
import { annualizationFigures, yearEndTargetAllowed, yearEndTargetOptions } from "@/lib/payroll/year-end-tax";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { fetchAllIn, fetchAllRows } from "@/lib/supabase/fetch-all";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_BRANCH = "00000000-0000-0000-0000-000000000000";

const RECORD_COLUMNS = "id,tax_year,employee_id,branch_id,employee_name,employee_code,gross_compensation,non_taxable,"
  + "taxable_compensation,tax_due,tax_withheld,adjustments_settled,balance,payslip_count,status,target_period,"
  + "scheduled_by_name,scheduled_at,computed_by_name,computed_at,run_count,history";

function refused(error) {
  const failure = describeYearEndError(error);
  return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
}

function yearOf(value, thisYear) {
  const year = /^\d{4}$/.test(String(value ?? "")) ? Number(value) : thisYear;
  return year >= 2000 && year <= thisYear ? year : null;
}

const num = (value) => Number(value) || 0;

/** A record as the page shows it, with the payslips that carry its adjustment. */
function shapeRecord(row, carried) {
  const lines = carried.filter((c) => c.employee_id === row.employee_id);
  const onTarget = row.status === "scheduled" ? lines.find((c) => c.pay_period === row.target_period) : null;
  const balance = num(row.balance);
  return {
    id: row.id,
    tax_year: row.tax_year,
    employee_id: row.employee_id,
    employee_name: row.employee_name || "—",
    employee_code: row.employee_code || "",
    gross_compensation: num(row.gross_compensation),
    non_taxable: num(row.non_taxable),
    taxable_compensation: num(row.taxable_compensation),
    tax_due: num(row.tax_due),
    tax_withheld: num(row.tax_withheld),
    adjustments_settled: num(row.adjustments_settled),
    balance,
    settlement: Math.abs(balance) < 0.01 ? "none" : balance > 0 ? "collect" : "refund",
    payslip_count: row.payslip_count,
    status: row.status,
    target_period: row.target_period,
    // scheduled → on a draft payslip → Final on the payslip
    schedule_state: row.status !== "scheduled" ? "none" : onTarget ? (onTarget.status === "paid" ? "final" : "on_payslip") : "waiting",
    scheduled_by_name: row.scheduled_by_name,
    scheduled_at: row.scheduled_at,
    computed_by_name: row.computed_by_name,
    computed_at: row.computed_at,
    run_count: row.run_count,
    adjustments: lines.map((c) => ({ pay_period: c.pay_period, status: c.status, kind: c.kind, amount: c.amount, signed: c.signed, shortfall: c.shortfall })),
  };
}

async function readYear(supabase, guard, year) {
  const branchId = birBranchScope(guard) || NO_BRANCH;
  // The branch's employees now (a record follows its employee's branch).
  const people = await fetchAllRows(() => supabase.from("profiles").select("id").eq("branch_id", branchId).order("id", { ascending: true }));
  if (people.error) throw new Error(`Employees: ${people.error.message}`);
  const ids = (people.data || []).map((p) => p.id);
  const records = ids.length
    ? await fetchAllIn(() => supabase.from("payroll_tax_annualizations").select(RECORD_COLUMNS).eq("tax_year", year).order("id", { ascending: true }), "employee_id", ids)
    : { data: [], error: null };
  if (records.error) return { available: false, error: describeYearEndError(records.error).error, rows: [] };
  const rows = records.data || [];
  // Payslips (draft or Final) carrying an adjustment of this tax year.
  const carriedResult = rows.length
    ? await fetchAllIn(() => supabase.from("payroll_entries").select("id,employee_id,pay_period,status,year_end_tax:payroll->year_end_tax")
      .not("payroll->year_end_tax", "is", null).order("id", { ascending: true }), "employee_id", rows.map((r) => r.employee_id))
    : { data: [], error: null };
  if (carriedResult.error) throw new Error(`Payslips: ${carriedResult.error.message}`);
  const carried = (carriedResult.data || [])
    .filter((e) => Number(e.year_end_tax?.tax_year) === year)
    .map((e) => ({
      employee_id: e.employee_id, pay_period: e.pay_period, status: e.status, kind: e.year_end_tax.kind,
      amount: num(e.year_end_tax.amount), signed: num(e.year_end_tax.signed), shortfall: num(e.year_end_tax.shortfall),
    }));
  return {
    available: true,
    rows: rows.map((row) => shapeRecord(row, carried))
      .sort((a, b) => a.employee_name.localeCompare(b.employee_name)),
  };
}

async function payload(supabase, guard, year) {
  const thisYear = Number(manilaDateKey().slice(0, 4));
  const [data, years] = await Promise.all([readYear(supabase, guard, year), birYears(supabase)]);
  const totals = data.rows.reduce((acc, r) => {
    acc.tax_due += r.tax_due;
    acc.tax_withheld += r.tax_withheld;
    if (r.balance > 0) acc.to_collect += r.balance;
    if (r.balance < 0) acc.to_refund += -r.balance;
    return acc;
  }, { tax_due: 0, tax_withheld: 0, to_collect: 0, to_refund: 0 });
  return {
    year,
    years: [...new Set([...years.filter((y) => y <= thisYear), year, thisYear])].sort((a, b) => b - a),
    finished: year < thisYear,
    ...data,
    totals,
    targets: yearEndTargetOptions(year, manilaDateKey()),
  };
}

export async function GET(request) {
  const guard = await requireBirAccountant(request, "read");
  if (guard.denied) return guard.denied;
  try {
    const thisYear = Number(manilaDateKey().slice(0, 4));
    const year = yearOf(new URL(request.url).searchParams.get("year") ?? thisYear, thisYear);
    if (!year) return NextResponse.json({ error: "Choose a year up to this one." }, { status: 400 });
    return NextResponse.json(await payload(getAdminClient(), guard, year));
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  const guard = await requireBirAccountant(request, "create");
  if (guard.denied) return guard.denied;
  try {
    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    const supabase = getAdminClient();
    const thisYear = Number(manilaDateKey().slice(0, 4));

    if (action === "run") {
      const year = yearOf(body.year, thisYear);
      if (!year) return NextResponse.json({ error: "Choose a year up to this one." }, { status: 400 });
      const data = await loadBirYear(supabase, { year, branchId: birBranchScope(guard) || NO_BRANCH });
      if (!data.tax_table_ready) return NextResponse.json({ error: `No tax table is in force for ${year}.`, code: "no_tax_table" }, { status: 400 });
      const rows = data.rows.map((row) => ({
        employee_id: row.employee_id,
        employee_name: row.full_name,
        employee_code: row.employee_code,
        ...annualizationFigures(row.form),
      }));
      if (rows.length) {
        const saved = await supabase.rpc("payroll_tax_annualization_save", { p_actor: guard.userId, p_year: year, p_rows: rows });
        if (saved.error) return refused(saved.error);
      }
      const collect = rows.filter((r) => r.balance > 0).length;
      const refund = rows.filter((r) => r.balance < 0).length;
      await appendAuditLog({
        actor: guard, module: "payroll", action: "tax_annualization_run", entity_type: "tax_annualization", entity_id: String(year),
        description: `Year-end tax annualization ${year}: ${rows.length} employee${rows.length === 1 ? "" : "s"} (${collect} under-withheld, ${refund} over-withheld).`,
        status: "success", source: "api", metadata: { year, count: rows.length, collect, refund },
      });
      return NextResponse.json({ ...(await payload(supabase, guard, year)), saved: rows.length });
    }

    if (action === "schedule" || action === "unschedule") {
      const id = normalizeText(body.id);
      if (!UUID.test(id)) return NextResponse.json({ error: "Choose the annualization." }, { status: 400 });
      const current = await supabase.from("payroll_tax_annualizations").select("id,tax_year,employee_name").eq("id", id).maybeSingle();
      if (current.error) return refused(current.error);
      if (!current.data) return NextResponse.json({ error: "No such annualization." }, { status: 404 });
      const period = action === "schedule" ? normalizeText(body.period) : null;
      if (action === "schedule" && !yearEndTargetAllowed(period, current.data.tax_year)) {
        return NextResponse.json({ error: `Choose a 2nd-cutoff payslip of ${current.data.tax_year} or January 16-31, ${current.data.tax_year + 1}.` }, { status: 400 });
      }
      const result = await supabase.rpc("payroll_tax_annualization_schedule", { p_actor: guard.userId, p_id: id, p_period: period });
      if (result.error) return refused(result.error);
      await appendAuditLog({
        actor: guard, module: "payroll", action: action === "schedule" ? "tax_annualization_scheduled" : "tax_annualization_unscheduled",
        entity_type: "tax_annualization", entity_id: id,
        description: action === "schedule"
          ? `Year-end tax adjustment ${current.data.tax_year} of ${current.data.employee_name || "an employee"} scheduled on the ${period} payslip.`
          : `Year-end tax adjustment ${current.data.tax_year} of ${current.data.employee_name || "an employee"} unscheduled.`,
        status: "success", source: "api", metadata: { id, year: current.data.tax_year, period },
      });
      return NextResponse.json(await payload(supabase, guard, current.data.tax_year));
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
