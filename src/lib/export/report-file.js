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
const blank = (v) => v === "" || v === null || v === undefined;

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

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})/;
/** "2026-11-19" → "Nov 19, 2026" (the one date format of every export). */
export function reportDate(value) {
  const m = DATE_KEY.exec(String(value ?? ""));
  if (!m) return String(value ?? "");
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}
/** "2026-11-19" → Excel's day number (a real date cell). */
function excelDay(value) {
  const m = DATE_KEY.exec(String(value ?? ""));
  return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000 : "";
}

/** A column is totalled when it is numeric, unless it says total: false. */
const totalled = (c) => isNumeric(c.kind) && c.total !== false;

function totalsRow(columns, rows) {
  return columns.map((c, i) => {
    if (i === 0) return "TOTAL";
    if (!totalled(c)) return "";
    const sum = rows.reduce((s, r) => s + (blank(r[i]) ? 0 : Number(signed(r[i], c.kind)) || 0), 0);
    return c.kind === "number" ? Math.round(sum * 100) / 100 : roundPeso(sum);
  });
}

function stamp() {
  return new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

/**
 * filters: [label, value] pairs (a plain "Label: value" string is taken as it
 * is). A column's kind: text | money | deduction | number | date (an ISO day);
 * total: false leaves a numeric column out of the totals row. empty: the line
 * an export with no rows shows (why nothing matched). note: a line under the
 * filters (e.g. what the totals cover).
 */
export async function buildReport({ format, title, branch = "All branches", period = "", filters = [], columns, rows, totals = false, empty = "", note = "" }) {
  const body = rows.map((r) => columns.map((c, i) => (isAmount(c.kind) ? (blank(r[i]) ? "" : signed(r[i], c.kind)) : r[i] ?? "")));
  const all = totals && body.length ? [...body, totalsRow(columns, body)] : body;
  const generated = stamp();
  // A pair with no value is left out; a plain string is shown as it is (never split into characters).
  const filterText = filters
    .map((f) => (Array.isArray(f) ? (blank(f[1]) ? "" : `${f[0]}: ${f[1]}`) : String(f ?? "")))
    .filter(Boolean).join(" · ");
  const count = `${rows.length} record${rows.length === 1 ? "" : "s"}`;
  const header = [`Branch: ${branch}`, period].filter(Boolean).join(" · ");
  const emptyLine = rows.length ? "" : empty || "No records match the filters above.";

  if (format === "pdf") {
    const cell = (v, i) => (blank(v) ? "" : isAmount(columns[i].kind) ? pesoPdf(v) : columns[i].kind === "date" ? reportDate(v) : String(v));
    return buildTablePdf({
      // The school is the PDF's first line already (table-pdf.js); the title is the report.
      title,
      subtitle: header,
      summary: [
        ...(filterText ? [["Filters", filterText]] : []),
        ["Records", count],
        ["Generated", generated],
        ...(note ? [["Note", note]] : []),
      ],
      columns: columns.map((c) => ({ header: c.header, align: isNumeric(c.kind) ? "right" : undefined })),
      // The totals row in bold; an empty export says why.
      // The totals row in bold; an empty export says why, across the full width.
      rows: all.map((r, n) => ({ cells: r.map(cell), bold: totals && n === all.length - 1 })),
      emptyText: emptyLine,
      footer: `System-generated report · ${SCHOOL_NAME} · ${generated}`,
    });
  }

  // Excel: the title, branch, period and filters above the table; dates as dates; totals as SUM formulas.
  const titleLines = [`${SCHOOL_NAME} — ${title}`, header, filterText ? `Filters: ${filterText}` : "", `${count} · Generated ${generated}`, note, emptyLine].filter(Boolean);
  const firstRow = titleLines.length + 3; // title lines, a blank row, the header row
  const lastRow = firstRow + body.length - 1;
  const dated = body.map((r) => r.map((v, i) => (columns[i].kind === "date" && !blank(v) ? excelDay(v) : v)));
  const xlsxRows = totals && body.length
    ? [...dated, totalsRow(columns, body).map((v, i) => (i > 0 && totalled(columns[i]) ? { f: `SUM(${columnName(i)}${firstRow}:${columnName(i)}${lastRow})`, v } : v))]
    : dated;
  return buildXlsx([
    {
      name: title.slice(0, 31), // buildXlsx removes the characters Excel refuses
      title: titleLines,
      columns: columns.map((c) => ({ header: c.kind === "deduction" ? `${c.header} (−)` : c.header, width: c.width || (isNumeric(c.kind) ? 14 : c.kind === "date" ? 13 : 22), integer: c.kind === "number" && c.integer, money: isAmount(c.kind), date: c.kind === "date" })),
      rows: xlsxRows,
    },
    {
      name: "About this report",
      columns: [{ header: "Item", width: 18 }, { header: "Details", width: 80 }],
      rows: [
        ["School", SCHOOL_NAME], ["Report", title], ["Branch", branch], ["Period", period || "—"],
        ["Filters", filterText || "None"], ["Records", rows.length], ["Generated", generated],
        ...(note ? [["Totals", note]] : []),
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
