/**
 * One report file, PDF or Excel, the same look everywhere (alpha test B6,
 * 2026-11-09): a header with the school, the report, the branch, the period
 * and the filters applied; one table (frozen header row in Excel; repeated
 * header, page numbers and landscape when wide in the PDF); amounts in pesos
 * with deductions NEGATIVE (-₱1,000.00); a totals row; "system-generated"
 * and the date at the foot.
 *
 *   return reportResponse({
 *     format: "pdf" | "xlsx", fileName: "branch-attendance-2026-11",
 *     title: "Branch attendance", branch: "Main Campus", period: "Nov 1 – 15, 2026",
 *     filters: [["Status", "All"]],
 *     columns: [{ header, kind?: "text" | "money" | "deduction" | "number" }],
 *     rows: [[...raw values]],
 *     totals: true,           // sums every money / deduction / number column
 *   });
 */

import { NextResponse } from "next/server";
import { buildTablePdf } from "@/lib/export/table-pdf";
import { buildXlsx } from "@/lib/export/xlsx";
import { roundPeso } from "@/lib/payroll/money";
import { pesoPdf } from "@/lib/export/pdf-text";
import { columnName } from "@/lib/export/xlsx";

export const SCHOOL_NAME = "Shepherd Angels Christian School";

const isAmount = (kind) => kind === "money" || kind === "deduction";
const isNumeric = (kind) => isAmount(kind) || kind === "number";

/** A deduction is always shown below zero, whatever sign it was stored with. */
export function signed(value, kind) {
  const n = roundPeso(Number(value) || 0);
  return kind === "deduction" ? -Math.abs(n) : n;
}

/** "₱1,000.00", "-₱1,000.00". */
export function pesoText(value) {
  const n = roundPeso(Number(value) || 0);
  const text = Math.abs(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}₱${text}`;
}

function totalsRow(columns, rows) {
  return columns.map((c, i) => {
    if (i === 0) return "TOTAL";
    if (!isNumeric(c.kind)) return "";
    const sum = rows.reduce((s, r) => s + (Number(signed(r[i], c.kind)) || 0), 0);
    return c.kind === "number" ? Math.round(sum * 100) / 100 : roundPeso(sum);
  });
}

function stamp() {
  return new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

export async function buildReport({ format, title, branch = "All branches", period = "", filters = [], columns, rows, totals = false }) {
  const body = rows.map((r) => columns.map((c, i) => (isAmount(c.kind) ? signed(r[i], c.kind) : r[i] ?? "")));
  const all = totals && body.length ? [...body, totalsRow(columns, body)] : body;
  const generated = stamp();
  const filterText = filters.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}: ${v}`).join(" · ");

  if (format === "pdf") {
    return buildTablePdf({
      // The school is the PDF's first line already (table-pdf.js); the title is the report.
      title,
      subtitle: [branch, period].filter(Boolean).join(" · "),
      summary: [
        ...(filterText ? [["Filters", filterText]] : []),
        ["Records", String(rows.length)],
        ["Generated", generated],
      ],
      columns: columns.map((c) => ({ header: c.header, align: isNumeric(c.kind) ? "right" : undefined })),
      // The totals row in bold.
      rows: all.map((r, n) => ({ cells: r.map((v, i) => (isAmount(columns[i].kind) && v !== "" ? pesoPdf(v) : String(v ?? ""))), bold: totals && body.length > 0 && n === all.length - 1 })),
      footer: `System-generated report · ${SCHOOL_NAME} · ${generated}`,
    });
  }

  // Excel: the title, branch, period and filters above the table; totals as SUM formulas.
  const titleLines = [`${SCHOOL_NAME} — ${title}`, [branch, period].filter(Boolean).join(" · "), filterText ? `Filters: ${filterText}` : "", `${rows.length} record${rows.length === 1 ? "" : "s"} · Generated ${generated}`].filter(Boolean);
  const firstRow = titleLines.length + 3; // title lines, a blank row, the header row
  const lastRow = firstRow + body.length - 1;
  const xlsxRows = totals && body.length
    ? [...body, totalsRow(columns, body).map((v, i) => (i > 0 && isNumeric(columns[i].kind) ? { f: `SUM(${columnName(i)}${firstRow}:${columnName(i)}${lastRow})`, v } : v))]
    : body;
  return buildXlsx([
    {
      name: title.slice(0, 31),
      title: titleLines,
      columns: columns.map((c) => ({ header: c.kind === "deduction" ? `${c.header} (−)` : c.header, width: c.width || (isNumeric(c.kind) ? 14 : 22), integer: c.kind === "number" && c.integer, money: isAmount(c.kind) })),
      rows: xlsxRows,
    },
    {
      name: "About this report",
      columns: [{ header: "Item", width: 18 }, { header: "Details", width: 80 }],
      rows: [
        ["School", SCHOOL_NAME], ["Report", title], ["Branch", branch], ["Period", period || "—"],
        ["Filters", filterText || "None"], ["Records", rows.length], ["Generated", generated],
        ["Note", "System-generated report. Deductions are shown as negative amounts."],
      ],
    },
  ]);
}

/** The file as a download response. */
export async function reportResponse({ format, fileName, ...report }) {
  const kind = format === "pdf" ? "pdf" : "xlsx";
  const file = await buildReport({ ...report, format: kind });
  return new NextResponse(file, {
    status: 200,
    headers: {
      "Content-Type": kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${String(fileName || "report").replace(/[^\w.-]+/g, "-")}.${kind}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** True when the request asks for a file (?format=pdf|xlsx). */
export function wantsFile(url) {
  const format = String(url.searchParams.get("format") || "").toLowerCase();
  return format === "pdf" || format === "xlsx" ? format : null;
}
