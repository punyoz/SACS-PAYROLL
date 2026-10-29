/**
 * The BIR files (2316 PDF, 1604-C alphalist Excel / CSV) and the record of
 * each one generated (payroll_bir_exports, 20261029010000). Server only.
 *
 *   buildBirFile({ kind, format, rows, employer, year, employeeCode })
 *     → { buffer, name, type }        the file, from loadBirYear() rows
 *   recordBirExport(supabase, guard, { kind, format, year, employeeId, rows, employer })
 *     → export id                     the Accountant generated it (the database
 *                                     checks the role and a 2316's branch)
 *   exportRows(stored, tinOf)         a stored export's rows, TINs filled in again
 *
 * A stored export keeps the figures exactly as generated, never the TINs:
 * those stay encrypted in profiles and are read again when the file is shown.
 * Viewing a stored export (the Super Admin's oversight) computes nothing.
 */

import { ALPHALIST_COLUMNS, alphalistRow, toCsv } from "@/lib/payroll/bir-2316";
import { build2316Pdf } from "@/lib/payroll/bir-2316-pdf";
import { formatTin } from "@/lib/payroll/bir-employer";
import { buildXlsx } from "@/lib/export/xlsx";

export const PDF = "application/pdf";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV = "text/csv; charset=utf-8";

/** The file for these rows. kind "bir_2316" → PDF; "alphalist" → xlsx / csv. */
export function buildBirFile({ kind, format, rows, employer, year, employeeCode = "" }) {
  if (kind === "bir_2316") {
    const name = employeeCode ? `BIR-2316-${year}-${employeeCode}.pdf` : `BIR-2316-${year}.pdf`;
    return { buffer: build2316Pdf(rows, { employer, year }), name, type: PDF };
  }
  const schedule1 = [];
  const schedule2 = [];
  rows.forEach((row) => (row.form.separated_in_year ? schedule2 : schedule1).push(row));
  const toRows = (list) => list.map((row, i) => alphalistRow({ seq: i + 1, tin: row.tin, name: row.name, form: row.form }));
  const headers = ALPHALIST_COLUMNS.map(([header]) => header);
  if (format === "xlsx") {
    const columns = headers.map((header, i) => ({ header, width: i === 0 ? 8 : i < 7 ? 16 : 20, integer: i === 0 }));
    return {
      buffer: buildXlsx([
        { name: "Schedule 1 - as of Dec 31", columns, rows: toRows(schedule1) },
        { name: "Schedule 2 - separated", columns, rows: toRows(schedule2) },
      ]),
      name: `Alphalist-1604C-${year}.xlsx`,
      type: XLSX,
    };
  }
  const lines = [...toRows(schedule1).map((r) => ["1", ...r]), ...toRows(schedule2).map((r) => ["2", ...r])];
  return { buffer: Buffer.from(`﻿${toCsv(["Schedule", ...headers], lines)}`, "utf8"), name: `Alphalist-1604C-${year}.csv`, type: CSV };
}

/** What is stored of a row: everything the file shows but the TIN (and not the payslip sources). */
function storedRow(row) {
  const { tin, sources, ...rest } = row;
  return rest;
}

/** Record a generated file; returns its id. Throws the database's refusal. */
export async function recordBirExport(supabase, guard, { kind, format, year, employeeId = null, rows, employer }) {
  const totals = {
    gross: rows.reduce((s, r) => s + (Number(r.form.boxes[19]) || 0), 0),
    tax_due: rows.reduce((s, r) => s + (Number(r.form.boxes[24]) || 0), 0),
    tax_withheld: rows.reduce((s, r) => s + (Number(r.form.boxes[26]) || 0), 0),
  };
  const result = await supabase.rpc("payroll_bir_export_save", {
    p_actor: guard.userId, p_kind: kind, p_year: year, p_format: format, p_employee: employeeId,
    p_rows: rows.map(storedRow), p_employer: employer, p_totals: totals,
  });
  if (result.error) throw Object.assign(new Error(result.error.message), { dbError: result.error });
  return Array.isArray(result.data) ? result.data[0] : result.data;
}

/** A stored export's rows with each TIN read again (`tinOf`: employee id → TIN). */
export function exportRows(stored, tinOf) {
  return (stored.rows || []).map((row) => ({ ...row, tin: formatTin(tinOf.get(row.employee_id) || "") }));
}
