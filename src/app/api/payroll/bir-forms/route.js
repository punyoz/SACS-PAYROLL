/**
 * BIR Form 2316 and the 1604-C alphalist (scenario AC-11, 2026-10-22;
 * src/lib/payroll/bir-forms.js), computed from paid, approved payslips. Each
 * file generated is recorded as generated (payroll_bir_exports; viewed later
 * through /api/payroll/bir-exports, also by the Super Admin, read-only).
 *
 *   GET ?year=YYYY                        the year's certificates (summary; TINs masked)
 *   GET ?year=YYYY&format=pdf[&employee_id=]   2316 PDF (one page per employee)
 *   GET ?year=YYYY&format=xlsx | csv      the alphalist (Schedule 1 as of Dec 31,
 *                                         Schedule 2 separated during the year)
 *
 * The Accountant only, under Payroll Reports (2026-10-29,
 * src/lib/payroll/bir-access.js): HR, Admin and Super Admin are refused.
 * The summary and the 2316 cover its own branch; the alphalist every branch
 * (one school-wide filing under one TIN).
 * The tax withheld includes the year-end tax adjustments settled on payslips
 * (/api/payroll/year-end-tax).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { ALPHALIST_SCOPE, birBranchScope, describeYearEndError, requireBirAccountant } from "@/lib/payroll/bir-access";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { buildBirFile, recordBirExport } from "@/lib/payroll/bir-exports";
import { birYears, loadBirYear } from "@/lib/payroll/bir-forms";
import { manilaDateKey } from "@/lib/payroll/periods";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// As every other TIN on screen: the last 4 digits (src/lib/employees/pii.js).
const maskTin = (tin) => (tin ? `••••${String(tin).replace(/\D/g, "").slice(0, 9).slice(-4)}` : "");

function summary(row) {
  const b = row.form.boxes;
  return {
    employee_id: row.employee_id,
    employee_code: row.employee_code,
    full_name: row.full_name,
    branch_name: row.branch_name,
    employee_status: row.employee_status,
    tin_masked: maskTin(row.tin),
    has_tin: Boolean(row.tin),
    period_from: row.form.period_from,
    period_to: row.form.period_to,
    separated_in_year: row.form.separated_in_year,
    payslip_count: row.form.payslip_count,
    gross: b[19],
    non_taxable: b[38],
    taxable: b[52],
    tax_due: b[24],
    tax_withheld: b[26],
    year_end_adjustment: row.form.year_end_adjustment || 0,
    difference: row.form.difference,
    settlement: row.form.settlement,
  };
}

function file(buffer, name, type) {
  return new NextResponse(buffer, {
    status: 200,
    headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}

export async function GET(request) {
  // The Accountant only, its own branch (src/lib/payroll/bir-access.js).
  const guard = await requireBirAccountant(request, "read");
  if (guard.denied) return guard.denied;
  try {
    const url = new URL(request.url);
    const thisYear = Number(manilaDateKey().slice(0, 4));
    const year = /^\d{4}$/.test(url.searchParams.get("year") || "") ? Number(url.searchParams.get("year")) : thisYear - 1;
    if (year < 2000 || year > thisYear) return NextResponse.json({ error: "Choose a year up to this one." }, { status: 400 });
    const format = String(url.searchParams.get("format") || "json").toLowerCase();
    const employeeId = url.searchParams.get("employee_id") || "";
    if (employeeId && !UUID.test(employeeId)) return NextResponse.json({ error: "Unknown employee." }, { status: 400 });

    if (!["json", "pdf", "xlsx", "csv"].includes(format)) return NextResponse.json({ error: "Unknown format." }, { status: 400 });
    const supabase = getAdminClient();
    // The alphalist is one school-wide filing: every branch's approved
    // payroll, read for this export only. Everything else: the Accountant's branch.
    const alphalist = format === "xlsx" || format === "csv";
    const branchId = alphalist ? ALPHALIST_SCOPE : birBranchScope(guard);
    const data = await loadBirYear(supabase, { year, branchId, employeeId: alphalist ? null : employeeId || null });

    if (format === "json") {
      const years = await birYears(supabase);
      return NextResponse.json({
        year,
        years: [...new Set([...years.filter((y) => y <= thisYear), year])].sort((a, b) => b - a),
        finished: year < thisYear,
        employer: data.employer,
        employer_missing: data.employer_missing,
        ceiling: data.ceiling,
        tax_table_ready: data.tax_table_ready,
        rows: data.rows.map(summary),
        totals: {
          gross: data.rows.reduce((s, r) => s + r.form.boxes[19], 0),
          tax_due: data.rows.reduce((s, r) => s + r.form.boxes[24], 0),
          tax_withheld: data.rows.reduce((s, r) => s + r.form.boxes[26], 0),
        },
        can_generate: guard.role === "accountant",
      });
    }

    if (employeeId && !data.rows.length) return NextResponse.json({ error: "No paid payslips for this employee in that year, or not in your branch." }, { status: 404 });

    const kind = alphalist ? "alphalist" : "bir_2316";
    const built = buildBirFile({ kind, format, rows: data.rows, employer: data.employer, year, employeeCode: employeeId ? data.rows[0].employee_code || "employee" : "" });
    // Kept as generated, for the record and the Super Admin's oversight.
    let exportId = null;
    try {
      exportId = await recordBirExport(supabase, guard, { kind, format, year, employeeId: employeeId && !alphalist ? employeeId : null, rows: data.rows, employer: data.employer });
    } catch (error) {
      const failure = describeYearEndError(error.dbError || error);
      // Before 20261029010000 there is nowhere to record it: the file is still given.
      if (failure.code !== "not_ready") return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
    }
    const response = file(built.buffer, built.name, built.type);
    if (exportId) response.headers.set("X-Bir-Export-Id", String(exportId));

    await appendAuditLog({
      actor: guard,
      module: "payroll",
      action: "bir_forms_export",
      entity_type: "bir_forms",
      entity_id: String(year),
      description: `${format === "pdf" ? "BIR Form 2316" : "1604-C alphalist (all branches)"} ${year} generated (${data.rows.length} employee${data.rows.length === 1 ? "" : "s"}).`,
      status: "success",
      source: "api",
      metadata: { year, format, employee_id: employeeId || null, count: data.rows.length, export_id: exportId, scope: alphalist ? "school" : "branch" },
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
