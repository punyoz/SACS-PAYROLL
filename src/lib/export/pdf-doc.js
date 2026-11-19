/**
 * The one PDF template (2026-11-19): every PDF the portal makes -- payslips
 * and every report -- is laid out here by @react-pdf/renderer, so rows size
 * themselves from their content (flexbox, no hand-placed coordinates). Print
 * prints the same PDF (src/lib/portal/print-pdf.js), so it looks the same.
 *
 * One font (Noto Sans, embedded, src/lib/export/pdf-text.js), A4 with 15 mm
 * margins, one footer, one rule for rows: a row is a box with 4 pt padding
 * and a bottom border across the full width, so a line never touches text
 * and wrapped text makes the row taller. Every table of a payslip uses the
 * same grid (Item 45% | Details 35% | Amount 20%) and the same 6 pt inner
 * padding, so amounts end at one x down the whole page.
 *
 *   renderPayslipDocument(model) -> Promise<Buffer>   (src/lib/payroll/payslip-pdf.js builds the model)
 *   renderTableDocument(model)   -> Promise<Buffer>   (src/lib/export/table-pdf.js builds the model)
 */

import React from "react";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { FONT, registerFonts } from "@/lib/export/pdf-text";

const h = React.createElement;

export const MARGIN = 42; // 15 mm
const INNER = 6; // left / right padding inside every band, row and box
const GAP = 10; // the space between sections, everywhere
const INK = "#111111";
const MUTED = "#5f6368";
const RULE = "#d0d4d8";
const BAND = "#eceff1";
const BOX = "#f3f5f6";

/** The payslip grid, shared by every section. */
const GRID = { item: "45%", details: "35%", amount: "20%" };

const S = StyleSheet.create({
  page: { fontFamily: FONT, fontSize: 9, color: INK, paddingTop: MARGIN, paddingHorizontal: MARGIN, paddingBottom: MARGIN + 30 },
  // No inherited line height: text uses Noto Sans's own (about 1.36). A line height set on the page stops
  // @react-pdf drawing the page number, and one inherited through a View is not read as a multiplier.
  content: {},
  bold: { fontWeight: 700 },
  muted: { color: MUTED },
  // Header
  header: { flexDirection: "row", alignItems: "center", paddingBottom: 8, marginBottom: GAP, borderBottomWidth: 0.75, borderBottomColor: "#b0b6bb" },
  seal: { width: 40, height: 40, marginRight: 10 },
  headerMain: { flexGrow: 1, flexShrink: 1, paddingRight: 12 },
  // Each size carries its own line height (an inherited 1.3 is resolved against the page's 9 pt).
  school: { fontSize: 15, fontWeight: 700, lineHeight: 1.25 },
  headerSub: { fontSize: 9, color: MUTED, marginTop: 2, lineHeight: 1.3 },
  headerSide: { alignItems: "flex-end", flexShrink: 0, maxWidth: 190 },
  status: { fontSize: 12, fontWeight: 700, textAlign: "right", lineHeight: 1.25 },
  // Employee grid: three columns; a value wraps inside its own column.
  gridRow: { flexDirection: "row", marginBottom: 6 },
  gridCell: { width: "33.333%", paddingRight: 10 },
  gridLabel: { fontSize: 7.5, color: MUTED },
  gridValue: { fontSize: 10, fontWeight: 700, lineHeight: 1.3 },
  line: { fontSize: 8.5, color: MUTED, marginBottom: 2 },
  // Sections
  section: { marginBottom: GAP },
  band: { flexDirection: "row", alignItems: "center", backgroundColor: BAND, paddingVertical: 4, paddingHorizontal: INNER },
  bandTitle: { fontWeight: 700 },
  bandHead: { fontSize: 7.5, color: MUTED },
  row: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: INNER, borderBottomWidth: 0.5, borderBottomColor: RULE },
  item: { width: GRID.item, paddingRight: 8 },
  details: { width: GRID.details, paddingRight: 8, fontSize: 8, color: MUTED },
  amount: { width: GRID.amount, textAlign: "right" },
  note: { paddingHorizontal: INNER, color: MUTED, marginBottom: 2 },
  // Attendance summary
  stats: { flexDirection: "row", paddingHorizontal: INNER, marginBottom: GAP },
  stat: { width: "16.666%" },
  // Summary box
  box: { backgroundColor: BOX, paddingVertical: 6, paddingHorizontal: INNER, marginBottom: GAP },
  boxRow: { flexDirection: "row", paddingVertical: 1.5 },
  boxLabel: { width: "70%" },
  boxAmount: { width: "30%", textAlign: "right" },
  net: { fontSize: 13, fontWeight: 700, lineHeight: 1.3 },
  monthTotal: { marginTop: 5, paddingTop: 5, borderTopWidth: 0.5, borderTopColor: RULE, fontSize: 8.5, fontWeight: 700 },
  // Footer on every page
  footer: { position: "absolute", left: MARGIN, right: MARGIN, bottom: MARGIN - 18, flexDirection: "row", alignItems: "flex-end", paddingTop: 4, borderTopWidth: 0.5, borderTopColor: RULE, fontSize: 7.5, color: MUTED },
  footerText: { flexGrow: 1, flexShrink: 1, paddingRight: 100 },
  pageNumber: { position: "absolute", right: MARGIN, bottom: MARGIN - 18, width: 90, textAlign: "right", fontSize: 7.5, color: MUTED },
  // Report tables
  title: { fontSize: 11, fontWeight: 700, marginTop: 2, lineHeight: 1.3 },
  pairs: { flexDirection: "row", flexWrap: "wrap", marginTop: 6, paddingBottom: 6, marginBottom: 6, borderBottomWidth: 0.75, borderBottomColor: "#b0b6bb" },
  pair: { width: 150, marginBottom: 4, paddingRight: 8 },
  thead: { flexDirection: "row", backgroundColor: BAND, paddingVertical: 4 },
  trow: { flexDirection: "row", paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: RULE },
  ttotal: { borderTopWidth: 0.75, borderTopColor: "#8a9096" },
  cell: { paddingHorizontal: 4 },
});

/**
 * The footer on every page: the note lines on the left; "Page x of y" on the
 * right. The page number is its own fixed Text directly on the page (the
 * only place @react-pdf fills in a page number), at the footer's baseline.
 */
function footer(lines) {
  return [
    h(View, { key: "footer", style: S.footer, fixed: true },
      h(View, { style: S.footerText }, ...lines.filter(Boolean).map((text, i) => h(Text, { key: i }, text)))),
    h(Text, { key: "page", style: S.pageNumber, fixed: true, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` }),
  ];
}

/** A payslip section: the band, then one row box per line, all on the shared grid. */
function Section({ section }) {
  if (section.kind === "notes") {
    // A note is a plain full-width line: no band, no column headers.
    return h(View, { style: S.section }, ...section.rows.map((r, i) => h(Text, { key: i, style: S.note }, r.label)));
  }
  const hasDetails = section.rows.some((r) => r.details);
  const hasAmount = section.rows.some((r) => r.amount);
  return h(View, { style: S.section },
    h(View, { style: S.band, minPresenceAhead: 30 },
      h(Text, { style: [S.item, S.bandTitle] }, section.title),
      h(Text, { style: [S.details, S.bandHead] }, hasDetails ? "Details" : ""),
      h(Text, { style: [S.amount, S.bandHead] }, hasAmount ? "Amount" : "")),
    ...section.rows.map((r, i) => h(View, { key: i, style: S.row, wrap: false },
      h(Text, { style: [S.item, r.bold ? S.bold : null] }, r.label),
      h(Text, { style: S.details }, r.details || ""),
      h(Text, { style: [S.amount, r.bold ? S.bold : null] }, r.amount || ""))));
}

/**
 * model: { seal?: Buffer (JPEG), status, payslipNo, subtitle, grid: [[[label, value] x3] ...],
 *   lines: [text], stats?: [[label, value]], sections: [{ title, kind?: "notes", rows: [{ label, details?, amount?, bold? }] }],
 *   summary: { rows: [[label, amount]], net: [label, amount], monthTotal?, by? }, footer: [text] }
 */
export function renderPayslipDocument(model) {
  registerFonts();
  const page = h(Page, { size: "A4", style: S.page }, h(View, { style: S.content },
    h(View, { style: S.header },
      model.seal ? h(Image, { style: S.seal, src: { data: model.seal, format: "jpg" } }) : null,
      h(View, { style: S.headerMain },
        h(Text, { style: S.school }, "Shepherd Angels Christian School"),
        h(Text, { style: S.headerSub }, model.subtitle)),
      h(View, { style: S.headerSide },
        h(Text, { style: [S.status, model.status === "Paid" ? null : S.muted] }, String(model.status || "").toUpperCase()),
        h(Text, { style: S.headerSub }, `Payslip No. ${model.payslipNo || "—"}`))),
    ...model.grid.map((cells, i) => h(View, { key: `g${i}`, style: S.gridRow },
      ...cells.map(([label, value], j) => h(View, { key: j, style: S.gridCell },
        h(Text, { style: S.gridLabel }, label),
        h(Text, { style: S.gridValue }, value || "—"))))),
    ...model.lines.map((text, i) => h(Text, { key: `l${i}`, style: S.line }, text)),
    model.stats ? h(View, { style: S.stats },
      ...model.stats.map(([label, value], i) => h(View, { key: i, style: S.stat },
        h(Text, { style: S.gridLabel }, label), h(Text, { style: S.gridValue }, String(value ?? 0))))) : null,
    h(View, { style: { marginTop: model.lines.length || model.stats ? 4 : 0 } }),
    ...model.sections.map((section, i) => h(Section, { key: `s${i}`, section })),
    h(View, { style: S.box, wrap: false },
      ...model.summary.rows.map(([label, amount], i) => h(View, { key: i, style: S.boxRow },
        h(Text, { style: S.boxLabel }, label), h(Text, { style: S.boxAmount }, amount))),
      h(View, { style: [S.boxRow, { marginTop: 3 }] },
        h(Text, { style: [S.boxLabel, S.net] }, model.summary.net[0]), h(Text, { style: [S.boxAmount, S.net] }, model.summary.net[1])),
      model.summary.monthTotal ? h(Text, { style: S.monthTotal }, model.summary.monthTotal) : null),
    model.summary.by ? h(Text, { style: S.line }, model.summary.by) : null),
    ...footer(model.footer));
  return renderToBuffer(h(Document, { title: `Payslip ${model.payslipNo || ""}`.trim(), author: "SACS Payroll", creator: "SACS Payroll", producer: "SACS Payroll" }, page));
}

/**
 * model: { orientation: "portrait" | "landscape", fontSize, title, subtitle, summary: [[label, value]],
 *   columns: [{ header, align?, width (pt) }], rows: [{ cells, bold? }], footer }
 * The column headers repeat at the top of every page; a row never splits across pages.
 */
export function renderTableDocument(model) {
  registerFonts();
  const cellStyle = (column, bold) => [S.cell, { width: column.width, textAlign: column.align === "right" ? "right" : "left" }, bold ? S.bold : null];
  const page = h(Page, { size: "A4", orientation: model.orientation, style: [S.page, { fontSize: model.fontSize }] }, h(View, { style: S.content },
    h(Text, { style: S.school }, "Shepherd Angels Christian School"),
    h(Text, { style: S.title }, model.title),
    model.subtitle ? h(Text, { style: S.headerSub }, model.subtitle) : null,
    h(View, { style: S.pairs },
      ...model.summary.map(([label, value], i) => h(View, { key: i, style: S.pair },
        h(Text, { style: S.gridLabel }, label), h(Text, { style: S.gridValue }, value)))),
    h(View, { style: S.thead, fixed: true },
      ...model.columns.map((column, i) => h(Text, { key: i, style: [...cellStyle(column, true), { fontSize: model.fontSize - 0.5, color: "#33373a" }] }, column.header))),
    ...model.rows.map((row, r) => h(View, { key: r, style: [S.trow, row.bold ? S.ttotal : null], wrap: false },
      ...row.cells.map((value, i) => h(Text, { key: i, style: [...cellStyle(model.columns[i], row.bold), row.muted ? S.muted : null] }, String(value ?? "")))))),
    ...footer([model.footer]));
  return renderToBuffer(h(Document, { title: model.title, author: "SACS Payroll", creator: "SACS Payroll", producer: "SACS Payroll" }, page));
}
