/**
 * An A4 report as a PDF, written by hand like the payslip
 * (src/lib/payroll/payslip-pdf.js, Helvetica, no dependency): a title block,
 * a few summary pairs, then a table that runs over as many pages as it needs,
 * with the header row repeated and page numbers in the footer.
 *
 * The columns are measured from their contents, so nothing is cut short: the
 * page is portrait when the table fits across it and landscape when it does
 * not, the font steps down a little before anything wraps, and long text
 * (names, notes, headers) wraps onto more lines instead of ending in "...".
 * Amounts never wrap.
 *
 *   buildTablePdf({ title, subtitle, summary: [[label, value]], columns:
 *     [{ header, align? }], rows: [[...]], footer, orientation? })  → Buffer
 *
 * `orientation` ("portrait" | "landscape") forces one; a column's `width` is
 * no longer used.
 */

import { pdfText } from "@/lib/payroll/payslip-pdf";

// Helvetica and Helvetica-Bold advance widths (Adobe AFM, 1/1000 em) for
// printable ASCII, from " " (32) to "~" (126): measuring with them is what
// keeps a cell's text inside its column.
const AFM_REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const AFM_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

const A4 = { portrait: [595, 842], landscape: [842, 595] };
const MARGIN = 32;
const PAD = 8; // left + right padding inside a cell
const HEAD_SIZE = 7;
const BODY_SIZES = [7.5, 7, 6.5];
const TEXT_CAP = 160; // a text column's widest before it wraps
const MAX_LINES = 3; // a text cell's lines before the rest is clipped
const lineHeight = (size) => size + 2.5;
/** Width in points of the text as the PDF writes it (pdfText turns ₱ into "PHP "). */
function width(value, size, bold = false) {
  const table = bold ? AFM_BOLD : AFM_REGULAR;
  const text = String(value ?? "").replace(/₱/g, "PHP ").replace(/[–—]/g, "-");
  let units = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (units * size) / 1000;
}

function clipToWidth(value, room, size, bold = false) {
  let text = String(value ?? "");
  if (width(text, size, bold) <= room) return text;
  while (text.length > 1 && width(`${text}...`, size, bold) > room) text = text.slice(0, -1);
  return `${text}...`;
}

/** Word-wrap to `room`, at most `maxLines` lines (the last one clipped). */
function wrap(value, room, size, { bold = false, maxLines = MAX_LINES } = {}) {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (!current || width(next, size, bold) <= room) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(" "));
  return lines.map((text) => clipToWidth(text, room, size, bold));
}

const longestWord = (value, size, bold) => Math.max(0, ...String(value ?? "").split(/\s+/).map((w) => width(w, size, bold)));

/** Column widths for one page width and font size, or null when they cannot fit. */
function fitColumns(columns, bodyRows, room, size) {
  const plans = columns.map((column, i) => {
    const amounts = column.align === "right";
    const cells = bodyRows.map((row) => row.cells[i]);
    const content = Math.max(0, ...bodyRows.map((row) => width(row.cells[i], size, Boolean(row.bold))));
    const headWord = longestWord(column.header, HEAD_SIZE, true);
    if (amounts) {
      // The header on one line when there is room, wrapped when the table is tight.
      const min = Math.max(content, headWord) + PAD;
      return { need: Math.max(min, width(column.header, HEAD_SIZE, true) + PAD), min };
    }
    const need = Math.min(Math.max(content, width(column.header, HEAD_SIZE, true)), TEXT_CAP) + PAD;
    // Narrow enough to wrap, wide enough that the longest text fits in MAX_LINES lines.
    const min = Math.min(need, Math.max(headWord, 36, (content / MAX_LINES) * 1.2, ...cells.map((value) => Math.min(longestWord(value, size, false), 60))) + PAD);
    return { need, min };
  });
  const need = plans.reduce((sum, p) => sum + p.need, 0);
  if (need <= room) {
    const grow = room / need; // spread the spare room so the table spans the page
    return plans.map((p) => p.need * grow);
  }
  const slack = plans.reduce((sum, p) => sum + (p.need - p.min), 0);
  const short = need - room;
  if (short > slack) return null;
  return plans.map((p) => p.need - (p.need - p.min) * (short / slack));
}

export function buildTablePdf({ title, subtitle = "", summary = [], columns = [], rows = [], footer = "", orientation }) {
  const bodyRows = rows.map((row) => (Array.isArray(row) ? { cells: row } : row));

  // Portrait first, then landscape; a slightly smaller font before either fails.
  const tries = (orientation ? [orientation] : ["portrait", "landscape"])
    .flatMap((o) => BODY_SIZES.map((size) => ({ o, size })));
  let plan = null;
  for (const { o, size } of tries) {
    const widths = fitColumns(columns, bodyRows, A4[o][0] - 2 * MARGIN, size);
    if (widths) {
      plan = { o, size, widths };
      break;
    }
  }
  if (!plan) {
    // Too wide even in landscape at the smallest size: scale down and clip.
    const o = orientation || "landscape";
    const size = BODY_SIZES.at(-1);
    const room = A4[o][0] - 2 * MARGIN;
    const natural = columns.map((column, i) => Math.max(
      longestWord(column.header, HEAD_SIZE, true),
      ...bodyRows.map((row) => width(row.cells[i], size, Boolean(row.bold))),
    ) + PAD);
    const total = natural.reduce((sum, w) => sum + w, 0);
    plan = { o, size, widths: natural.map((w) => (w * room) / total) };
  }

  const [PAGE_W, PAGE_H] = A4[plan.o];
  const { size: BODY, widths } = plan;
  const ROOM = PAGE_W - 2 * MARGIN;
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;

  const text = (x, at, value, { size = 8, bold = false, gray = 0 } = {}) => {
    ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${at.toFixed(2)} Td (${pdfText(value)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, gray = 0.8) => ops.push(`${gray} G 0.5 w ${x1} ${y1} m ${x2} ${y2} l S`);
  const cellLines = (value, i, size, bold) => (columns[i]?.align === "right"
    ? [clipToWidth(value, widths[i] - PAD, size, bold)]
    : wrap(value, widths[i] - PAD, size, { bold }));
  // One row of cells, each cell's lines stacked down from y; returns its height.
  const drawRow = (lines, size, { bold = false, gray = 0 } = {}) => {
    let x = MARGIN;
    lines.forEach((cell, i) => {
      cell.forEach((label, n) => {
        const at = columns[i]?.align === "right" ? x + widths[i] - PAD / 2 - width(label, size, bold) : x + PAD / 2;
        text(at, y - n * lineHeight(size), label, { size, bold, gray });
      });
      x += widths[i];
    });
    return Math.max(1, ...lines.map((cell) => cell.length)) * lineHeight(size);
  };
  // Headers wrap in every column (amount headers too), two lines at most.
  const headLines = columns.map((column, i) => wrap(column.header, widths[i] - PAD, HEAD_SIZE, { bold: true, maxLines: 2 }));
  const header = () => {
    y -= drawRow(headLines, HEAD_SIZE, { bold: true, gray: 0.25 }) - lineHeight(HEAD_SIZE) + 4;
    line(MARGIN, y, PAGE_W - MARGIN, y, 0.6);
    y -= lineHeight(BODY) + 1;
  };
  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
    text(MARGIN, y, clipToWidth(title, ROOM, 10, true), { size: 10, bold: true });
    y -= 18;
    header();
  };

  text(MARGIN, y, "Shepherd Angels Christian School", { size: 14, bold: true });
  y -= 16;
  wrap(title, ROOM, 11, { bold: true, maxLines: 2 }).forEach((label) => {
    text(MARGIN, y, label, { size: 11, bold: true });
    y -= 13;
  });
  if (subtitle) {
    wrap(subtitle, ROOM, 9, { maxLines: 3 }).forEach((label) => {
      text(MARGIN, y, label, { size: 9, gray: 0.35 });
      y -= 11;
    });
    y -= 3;
  }
  if (summary.length) {
    // As many label/value pairs per line as fit, at least 120pt each.
    const perLine = Math.max(1, Math.min(summary.length, Math.floor(ROOM / 120)));
    const cell = ROOM / perLine;
    for (let start = 0; start < summary.length; start += perLine) {
      summary.slice(start, start + perLine).forEach(([label, value], i) => {
        text(MARGIN + i * cell, y, clipToWidth(label, cell - 8, 7), { size: 7, gray: 0.45 });
        text(MARGIN + i * cell, y - 11, clipToWidth(value, cell - 8, 10, true), { size: 10, bold: true });
      });
      y -= 26;
    }
  }
  line(MARGIN, y + 6, PAGE_W - MARGIN, y + 6);
  y -= 6;
  header();

  bodyRows.forEach((row) => {
    const bold = Boolean(row.bold);
    const lines = row.cells.map((value, i) => cellLines(value, i, BODY, bold));
    const height = Math.max(1, ...lines.map((cell) => cell.length)) * lineHeight(BODY);
    if (y - height + lineHeight(BODY) < MARGIN + 18) newPage();
    if (bold) line(MARGIN, y + lineHeight(BODY) - 1, PAGE_W - MARGIN, y + lineHeight(BODY) - 1, 0.5);
    drawRow(lines, BODY, { bold, gray: row.muted ? 0.4 : 0 });
    y -= height + 2.5;
  });
  pages.push(ops);

  const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const streams = pages.map((pageOps, i) => {
    const foot = `${footer ? `${footer} · ` : ""}Page ${i + 1} of ${pages.length}`;
    const all = [...pageOps, `0.5 g BT /F1 7 Tf ${MARGIN} ${MARGIN - 14} Td (${pdfText(foot)}) Tj ET`];
    return Buffer.from(all.join("\n"), "latin1");
  });
  pages.forEach((_, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(null); // the content stream, written below
  });

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let length = chunks[0].length;
  const push = (buffer) => { chunks.push(buffer); length += buffer.length; };
  let streamIndex = 0;
  objects.forEach((body, index) => {
    offsets.push(length);
    if (body === null) {
      const content = streams[streamIndex++];
      push(Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`, "latin1"),
        content,
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ]));
    } else {
      push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1"));
    }
  });
  const xrefAt = length;
  const xref = ["xref", `0 ${offsets.length + 1}`, "0000000000 65535 f "]
    .concat(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `))
    .join("\n");
  push(Buffer.from(`${xref}\ntrailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}
