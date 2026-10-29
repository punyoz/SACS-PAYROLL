/**
 * BIR Form 2316 and the 1604-C alphalist (scenario AC-11, 2026-10-22;
 * src/lib/payroll/bir-forms.js). Read-only: the forms are computed from paid,
 * approved payslips each time, never stored.
 *
 *   GET ?year=YYYY                        the year's certificates (summary; TINs masked)
 *   GET ?year=YYYY&format=pdf[&employee_id=]   2316 PDF (one page per employee)
 *   GET ?year=YYYY&format=xlsx | csv      the alphalist (Schedule 1 as of Dec 31,
 *                                         Schedule 2 separated during the year)
 *
 * The Accountant only, its own branch, under Payroll Reports (2026-10-29,
 * src/lib/payroll/bir-access.js): HR, Admin and Super Admin are refused.
 * The tax withheld includes the year-end tax adjustments settled on payslips
 * (/api/payroll/year-end-tax).
 */

import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { birBranchScope, requireBirAccountant } from "@/lib/payroll/bir-access";
import { getServiceClient as getAdminClient } from "@/lib/supabase/admin";
import { ALPHALIST_COLUMNS, alphalistRow, toCsv } from "@/lib/payroll/bir-2316";
import { build2316Pdf } from "@/lib/payroll/bir-2316-pdf";
import { birYears, loadBirYear } from "@/lib/payroll/bir-forms";
import { manilaDateKey } from "@/lib/payroll/periods";
import { buildXlsx } from "@/lib/export/xlsx";

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

    const supabase = getAdminClient();
    const branchId = birBranchScope(guard);
    const data = await loadBirYear(supabase, { year, branchId, employeeId: employeeId || null });

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

    if (!["pdf", "xlsx", "csv"].includes(format)) return NextResponse.json({ error: "Unknown format." }, { status: 400 });
    if (employeeId && !data.rows.length) return NextResponse.json({ error: "No paid payslips for this employee in that year, or not in your branch." }, { status: 404 });

    let response;
    if (format === "pdf") {
      const name = employeeId ? `BIR-2316-${year}-${data.rows[0].employee_code || "employee"}.pdf` : `BIR-2316-${year}.pdf`;
      response = file(build2316Pdf(data.rows, { employer: data.employer, year }), name, "application/pdf");
    } else {
      const schedule1 = [];
      const schedule2 = [];
      data.rows.forEach((row) => (row.form.separated_in_year ? schedule2 : schedule1).push(row));
      const toRows = (list) => list.map((row, i) => alphalistRow({ seq: i + 1, tin: row.tin, name: row.name, form: row.form }));
      const headers = ALPHALIST_COLUMNS.map(([header]) => header);
      if (format === "xlsx") {
        const columns = headers.map((header, i) => ({ header, width: i === 0 ? 8 : i < 7 ? 16 : 20, integer: i === 0 }));
        response = file(buildXlsx([
          { name: "Schedule 1 - as of Dec 31", columns, rows: toRows(schedule1) },
          { name: "Schedule 2 - separated", columns, rows: toRows(schedule2) },
        ]), `Alphalist-1604C-${year}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      } else {
        const rows = [...toRows(schedule1).map((r) => ["1", ...r]), ...toRows(schedule2).map((r) => ["2", ...r])];
        response = file(Buffer.from(`﻿${toCsv(["Schedule", ...headers], rows)}`, "utf8"), `Alphalist-1604C-${year}.csv`, "text/csv; charset=utf-8");
      }
    }

    await appendAuditLog({
      actor: guard,
      module: "payroll",
      action: "bir_forms_export",
      entity_type: "bir_forms",
      entity_id: String(year),
      description: `${format === "pdf" ? "BIR Form 2316" : "1604-C alphalist"} ${year} downloaded (${data.rows.length} employee${data.rows.length === 1 ? "" : "s"}).`,
      status: "success",
      source: "api",
      metadata: { year, format, employee_id: employeeId || null, count: data.rows.length },
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
