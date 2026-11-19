/**
 * A report as an A4 PDF (2026-11-19: laid out by the shared template,
 * src/lib/export/pdf-doc.js): the school, the report's title, a few summary
 * pairs (filters, records, generated), then a table whose header row repeats
 * on every page; a row never splits; page x of y in the footer.
 *
 * The columns are measured from their contents with the embedded font
 * (src/lib/export/pdf-text.js): portrait when the table fits across it,
 * landscape when it does not, a slightly smaller size before either fails.
 * Text wraps inside its column (the row grows); amounts never wrap and are
 * never cut short.
 *
 *   await buildTablePdf({ title, subtitle, summary: [[label, value]], columns:
 *     [{ header, align? }], rows: [[...] | { cells, bold?, muted? }], footer, orientation? })  → Buffer
 *
 * `orientation` ("portrait" | "landscape") forces one; a column's `width` is not used.
 */

import { MARGIN, renderTableDocument } from "@/lib/export/pdf-doc";
import { textWidth } from "@/lib/export/pdf-text";

const A4 = { portrait: 595, landscape: 842 };
const PAD = 8; // a cell's left + right padding
const SIZES = [8, 7.5, 7];
const TEXT_CAP = 170; // a text column's widest before it wraps

const longestWord = (value, size, bold) => Math.max(0, ...String(value ?? "").split(/\s+/).map((w) => textWidth(w, size, bold)));

/** Column widths for one page width and font size, or null when they cannot fit. */
function fitColumns(columns, rows, room, size) {
  const plans = columns.map((column, i) => {
    const content = Math.max(0, ...rows.map((row) => textWidth(row.cells[i], size, Boolean(row.bold))));
    const head = textWidth(column.header, size - 0.5, true);
    const headWord = longestWord(column.header, size - 0.5, true);
    if (column.align === "right") {
      // An amount never wraps; its header may.
      const min = Math.max(content, headWord) + PAD;
      return { need: Math.max(min, head + PAD), min };
    }
    const need = Math.min(Math.max(content, head), TEXT_CAP) + PAD;
    const words = Math.max(headWord, ...rows.map((row) => Math.min(longestWord(row.cells[i], size, Boolean(row.bold)), 70)));
    return { need, min: Math.min(need, Math.max(words, 40) + PAD) };
  });
  const need = plans.reduce((sum, p) => sum + p.need, 0);
  if (need <= room) return plans.map((p) => (p.need * room) / need); // spread to the full width
  const slack = plans.reduce((sum, p) => sum + (p.need - p.min), 0);
  const short = need - room;
  if (short > slack) return null;
  return plans.map((p) => p.need - (p.need - p.min) * (short / slack));
}

export function buildTablePdf({ title, subtitle = "", summary = [], columns = [], rows = [], footer = "", orientation }) {
  const body = rows.map((row) => (Array.isArray(row) ? { cells: row } : row)).map((row) => ({ ...row, cells: row.cells.map((v) => String(v ?? "")) }));
  const tries = (orientation ? [orientation] : ["portrait", "landscape"]).flatMap((o) => SIZES.map((size) => ({ o, size })));
  let plan = null;
  for (const { o, size } of tries) {
    const widths = fitColumns(columns, body, A4[o] - 2 * MARGIN, size);
    if (widths) { plan = { o, size, widths }; break; }
  }
  if (!plan) {
    // Wider than landscape at the smallest size: every column shares the width and text wraps.
    const o = orientation || "landscape";
    const size = SIZES.at(-1);
    const natural = columns.map((column, i) => Math.max(longestWord(column.header, size, true), ...body.map((row) => longestWord(row.cells[i], size))) + PAD);
    const total = natural.reduce((sum, w) => sum + w, 0);
    plan = { o, size, widths: natural.map((w) => (w * (A4[o] - 2 * MARGIN)) / total) };
  }
  return renderTableDocument({
    orientation: plan.o,
    fontSize: plan.size,
    title,
    subtitle,
    summary,
    columns: columns.map((column, i) => ({ header: column.header, align: column.align, width: plan.widths[i] })),
    rows: body,
    footer,
  });
}
