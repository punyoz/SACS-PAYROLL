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
  emptyRow: { paddingVertical: 6, paddingHorizontal: 4, color: MUTED, borderBottomWidth: 0.5, borderBottomColor: RULE },
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

/* ── The payslip (2026-11-22): two panels, Earnings | Deductions ── */

const PANEL_GAP = 12;
const HEAD = "#dfe6ea"; // header cells, panel titles and total bars
const P = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingBottom: 8, marginBottom: 8, borderBottomWidth: 0.75, borderBottomColor: "#b0b6bb" },
  title: { fontSize: 20, fontWeight: 700, textAlign: "right", lineHeight: 1.2, letterSpacing: 1 },
  strip: { flexDirection: "row", marginBottom: 8 },
  stripCell: { flexGrow: 1, flexBasis: 0, marginRight: 4 },
  stripLast: { flexGrow: 1, flexBasis: 0 },
  stripLabel: { backgroundColor: HEAD, paddingVertical: 2.5, paddingHorizontal: INNER, fontSize: 7, fontWeight: 700, color: "#33373a", lineHeight: 1.3 },
  stripValue: { paddingVertical: 3, paddingHorizontal: INNER, borderBottomWidth: 0.5, borderBottomColor: RULE, fontSize: 9, lineHeight: 1.3 },
  panels: { flexDirection: "row", marginBottom: GAP },
  panel: { flexGrow: 1, flexBasis: 0, flexDirection: "column", borderWidth: 0.5, borderColor: RULE },
  panelGap: { width: PANEL_GAP },
  panelTitle: { flexDirection: "row", backgroundColor: HEAD, paddingVertical: 4, paddingHorizontal: INNER },
  panelBody: { flexGrow: 1 },
  group: { paddingTop: 5, paddingBottom: 2, paddingHorizontal: INNER, fontSize: 7, fontWeight: 700, color: MUTED, letterSpacing: 0.4, lineHeight: 1.3 },
  prow: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 3, paddingHorizontal: INNER, borderBottomWidth: 0.5, borderBottomColor: RULE },
  pitem: { width: "64%", paddingRight: 6 },
  pformula: { fontSize: 7, color: MUTED, lineHeight: 1.3, marginTop: 0.5 },
  pamount: { width: "36%", textAlign: "right" },
  ptotal: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: INNER, backgroundColor: HEAD },
  netBox: { flexDirection: "row", alignItems: "flex-end", backgroundColor: BOX, borderWidth: 0.5, borderColor: RULE, paddingVertical: 6, paddingHorizontal: INNER, marginBottom: 4 },
  netPart: { flexGrow: 1, flexBasis: 0 },
  netSign: { width: 16, textAlign: "center", fontSize: 11, color: MUTED, lineHeight: 1.3 },
  netValue: { fontSize: 11, fontWeight: 700, lineHeight: 1.3 },
  netBig: { fontSize: 14, fontWeight: 700, lineHeight: 1.3, textAlign: "right" },
  monthTotal: { fontSize: 8.5, fontWeight: 700, marginBottom: GAP, paddingHorizontal: INNER, lineHeight: 1.3 },
  boxes: { flexDirection: "row", marginBottom: GAP },
  box: { flexGrow: 1, flexBasis: 0, borderWidth: 0.5, borderColor: RULE },
  brow: { flexDirection: "row", paddingVertical: 2.5, paddingHorizontal: INNER, borderBottomWidth: 0.5, borderBottomColor: RULE },
  blabel: { width: "64%", paddingRight: 6 },
  bamount: { width: "36%", textAlign: "right" },
  bnote: { paddingVertical: 3, paddingHorizontal: INNER, fontSize: 7, color: MUTED, lineHeight: 1.3 },
  // A dense payslip (many deduction lines, 2026-11-25): tighter rows so it still fits one A4 page.
  prowTight: { paddingVertical: 1.5 },
  browTight: { paddingVertical: 1.2 },
  pformulaTight: { lineHeight: 1.15, marginTop: 0 },
  groupTight: { paddingTop: 2.5, paddingBottom: 1 },
});

function panelRows(rows, tight = false) {
  return rows.map((r, i) => (r.group
    ? h(Text, { key: i, style: [P.group, tight ? P.groupTight : null] }, r.group)
    : h(View, { key: i, style: [P.prow, tight ? P.prowTight : null], wrap: false },
      h(View, { style: [P.pitem, r.indent ? { paddingLeft: 8 } : null] },
        h(Text, { style: r.indent ? { fontSize: 8, color: MUTED } : null }, r.label),
        r.formula ? h(Text, { style: [P.pformula, tight ? P.pformulaTight : null] }, r.formula) : null),
      h(Text, { style: [P.pamount, r.indent ? { fontSize: 8, color: MUTED } : null] }, r.amount || ""))));
}

/** A panel: its title over Item | Amount, the rows, and its total at the bottom (both totals on one line). */
function Panel({ panel, tight }) {
  return h(View, { style: P.panel },
    h(View, { style: P.panelTitle },
      h(Text, { style: [P.pitem, S.bold] }, panel.title),
      h(Text, { style: [P.pamount, S.bandHead] }, "Amount")),
    h(View, { style: P.panelBody }, ...panelRows(panel.rows, tight)),
    h(View, { style: P.ptotal, wrap: false },
      h(Text, { style: [P.pitem, S.bold] }, panel.total[0]),
      h(Text, { style: [P.pamount, S.bold] }, panel.total[1])));
}

/** A small box (tax computation, year to date): title, label | amount rows, an optional note. */
function SmallBox({ box, last, tight }) {
  return h(View, { style: [P.box, last ? null : { marginRight: PANEL_GAP }], wrap: false },
    h(View, { style: P.panelTitle }, h(Text, { style: S.bold }, box.title)),
    ...box.rows.map(([label, amount, bold], i) => h(View, { key: i, style: [P.brow, tight ? P.browTight : null] },
      h(Text, { style: [P.blabel, bold ? S.bold : null] }, label),
      h(Text, { style: [P.bamount, bold ? S.bold : null] }, amount || ""))),
    box.note ? h(Text, { style: P.bnote }, box.note) : null);
}

/**
 * model: { seal?: Buffer (JPEG), school, branchLine, status, payslipNo,
 *   strip: [[label, value]] (header cells), grid: [[[label, value] x3] ...], lines: [text],
 *   stats?: [[label, value]],
 *   panels?: { earnings: { title, rows: [{ label, formula?, amount, indent? } | { group }], total: [label, amount] }, deductions: {...} },
 *   sections?: [...] (an older payslip without per-line figures: the one-column layout),
 *   notes: [text], net: { gross, deductions, carried?, net, netLabel }, monthTotal?, boxes: [{ title, rows: [[label, amount, bold?]], note? }],
 *   by?, footer: [text] }
 */
export function renderPayslipDocument(model) {
  registerFonts();
  const page = h(Page, { size: "A4", style: S.page }, h(View, { style: S.content },
    h(View, { style: P.header },
      model.seal ? h(Image, { style: S.seal, src: { data: model.seal, format: "jpg" } }) : null,
      h(View, { style: S.headerMain },
        h(Text, { style: S.school }, model.school || "Shepherd Angels Christian School"),
        h(Text, { style: S.headerSub }, model.branchLine)),
      h(View, { style: S.headerSide },
        h(Text, { style: P.title }, "PAYSLIP"),
        h(Text, { style: [S.headerSub, { textAlign: "right" }] }, `No. ${model.payslipNo || "—"}`),
        h(Text, { style: [S.headerSub, S.bold, { textAlign: "right" }, model.status === "Paid" ? { color: INK } : null] }, String(model.status || "").toUpperCase()))),
    h(View, { style: P.strip },
      ...model.strip.map(([label, value], i) => h(View, { key: i, style: i === model.strip.length - 1 ? P.stripLast : P.stripCell },
        h(Text, { style: P.stripLabel }, label),
        h(Text, { style: P.stripValue }, value || "—")))),
    ...model.grid.map((cells, i) => h(View, { key: `g${i}`, style: S.gridRow },
      ...cells.map(([label, value], j) => h(View, { key: j, style: S.gridCell },
        h(Text, { style: S.gridLabel }, label),
        h(Text, { style: S.gridValue }, value || "—"))))),
    ...model.lines.map((text, i) => h(Text, { key: `l${i}`, style: S.line }, text)),
    model.stats ? h(View, { style: S.stats },
      ...model.stats.map(([label, value], i) => h(View, { key: i, style: S.stat },
        h(Text, { style: S.gridLabel }, label), h(Text, { style: S.gridValue }, String(value ?? 0))))) : null,
    h(View, { style: { marginTop: 4 } }),
    model.panels
      ? h(View, { style: P.panels },
        h(Panel, { panel: model.panels.earnings, tight: model.tight }),
        h(View, { style: P.panelGap }),
        h(Panel, { panel: model.panels.deductions, tight: model.tight }))
      : null,
    ...(model.sections || []).map((section, i) => h(Section, { key: `s${i}`, section })),
    ...(model.notes || []).map((text, i) => h(Text, { key: `n${i}`, style: [S.note, { marginBottom: 4 }] }, text)),
    h(View, { style: P.netBox, wrap: false },
      h(View, { style: P.netPart }, h(Text, { style: S.gridLabel }, "Gross pay"), h(Text, { style: P.netValue }, model.net.gross)),
      h(Text, { style: P.netSign }, "−"),
      h(View, { style: P.netPart }, h(Text, { style: S.gridLabel }, "Total deductions"), h(Text, { style: P.netValue }, model.net.deductions)),
      // Deductions above the pay are carried to next month: added back so the line adds up.
      model.net.carried ? h(Text, { style: P.netSign }, "+") : null,
      model.net.carried ? h(View, { style: P.netPart }, h(Text, { style: S.gridLabel }, "Carried to next month"), h(Text, { style: P.netValue }, model.net.carried)) : null,
      // A final pay whose deductions are above the pay: never negative pay; HR recovers the rest.
      model.net.recover ? h(Text, { style: P.netSign }, "+") : null,
      model.net.recover ? h(View, { style: P.netPart }, h(Text, { style: S.gridLabel }, "Overpayment to recover"), h(Text, { style: P.netValue }, model.net.recover)) : null,
      h(Text, { style: P.netSign }, "="),
      h(View, { style: [P.netPart, { alignItems: "flex-end" }] },
        h(Text, { style: [S.gridLabel, { textAlign: "right" }] }, model.net.netLabel),
        h(Text, { style: P.netBig }, model.net.net))),
    model.monthTotal ? h(Text, { style: P.monthTotal }, model.monthTotal) : h(View, { style: { marginBottom: GAP - 4 } }),
    model.boxes?.length
      // One box (a 1st half: year to date only) keeps the right column, so its amounts line up with Deductions.
      ? h(View, { style: P.boxes }, ...(model.boxes.length === 1 ? [null, model.boxes[0]] : model.boxes).map((box, i, all) => (box
        ? h(SmallBox, { key: i, box, last: i === all.length - 1, tight: model.tight })
        : h(View, { key: i, style: { flexGrow: 1, flexBasis: 0, marginRight: PANEL_GAP } }))))
      : null,
    // The Leave Balance as one line when the boxes leave no room for it (2026-11-25), for information only.
    model.leaveLine ? h(Text, { style: S.line }, model.leaveLine) : null,
    model.by ? h(Text, { style: S.line }, model.by) : null),
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
    // No rows: one full-width line saying why (never squeezed into the first column).
    model.emptyText ? h(Text, { style: S.emptyRow }, model.emptyText) : null,
    ...model.rows.map((row, r) => h(View, { key: r, style: [S.trow, row.bold ? S.ttotal : null], wrap: false },
      ...row.cells.map((value, i) => h(Text, { key: i, style: [...cellStyle(model.columns[i], row.bold), row.muted ? S.muted : null] }, String(value ?? "")))))),
    ...footer([model.footer]));
  return renderToBuffer(h(Document, { title: model.title, author: "SACS Payroll", creator: "SACS Payroll", producer: "SACS Payroll" }, page));
}

/**
 * A one-page letter (Part D, 2026-11-22: the AWOL 1st notice from its editable
 * template): the school, a title, paragraphs, a footer line.
 */
export function renderLetterDocument({ title, paragraphs = [], footerText = "" }) {
  registerFonts();
  const page = h(Page, { size: "A4", style: [S.page, { fontSize: 10.5 }] }, h(View, { style: S.content },
    h(Text, { style: S.school }, "Shepherd Angels Christian School"),
    h(Text, { style: S.title }, title),
    ...paragraphs.map((p, i) => h(Text, { key: i, style: { marginTop: 10, lineHeight: 1.45 } }, p))),
    ...footer([footerText]));
  return renderToBuffer(h(Document, { title, author: "SACS Payroll", creator: "SACS Payroll", producer: "SACS Payroll" }, page));
}
