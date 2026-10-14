/**
 * A landscape A4 report as a PDF, written by hand like the payslip
 * (src/lib/payroll/payslip-pdf.js, Helvetica, no dependency): a title block,
 * a few summary pairs, then a table that runs over as many pages as it needs,
 * with the header row repeated and page numbers in the footer.
 *
 *   buildTablePdf({ title, subtitle, summary: [[label, value]], columns:
 *     [{ header, width, align? }], rows: [[...]], footer })  → Buffer
 */

import { pdfText, textWidth } from "@/lib/payroll/payslip-pdf";

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 32;
const ROW_H = 13;

function clipToWidth(value, width, size) {
  let text = String(value ?? "");
  if (textWidth(text, size) <= width) return text;
  while (text.length > 1 && textWidth(`${text}...`, size) > width) text = text.slice(0, -1);
  return `${text}...`;
}

export function buildTablePdf({ title, subtitle = "", summary = [], columns = [], rows = [], footer = "" }) {
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;
  const scale = Math.min(1, (PAGE_W - 2 * MARGIN) / columns.reduce((sum, c) => sum + (c.width || 60), 0));
  const widths = columns.map((c) => (c.width || 60) * scale);

  const text = (x, at, value, { size = 8, bold = false, gray = 0 } = {}) => {
    ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${at.toFixed(2)} Td (${pdfText(value)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, gray = 0.8) => ops.push(`${gray} G 0.5 w ${x1} ${y1} m ${x2} ${y2} l S`);
  const header = () => {
    let x = MARGIN;
    columns.forEach((column, i) => {
      const label = clipToWidth(column.header, widths[i] - 4, 7);
      const at = column.align === "right" ? x + widths[i] - 2 - textWidth(label, 7) : x + 2;
      text(at, y, label, { size: 7, bold: true, gray: 0.25 });
      x += widths[i];
    });
    y -= 4;
    line(MARGIN, y, PAGE_W - MARGIN, y, 0.6);
    y -= ROW_H - 3;
  };
  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
    text(MARGIN, y, title, { size: 10, bold: true });
    y -= 18;
    header();
  };

  text(MARGIN, y, "Shepherd Angels Christian School", { size: 14, bold: true });
  y -= 16;
  text(MARGIN, y, title, { size: 11, bold: true });
  y -= 13;
  if (subtitle) {
    text(MARGIN, y, subtitle, { size: 9, gray: 0.35 });
    y -= 14;
  }
  if (summary.length) {
    const cell = (PAGE_W - 2 * MARGIN) / summary.length;
    summary.forEach(([label, value], i) => {
      text(MARGIN + i * cell, y, label, { size: 7, gray: 0.45 });
      text(MARGIN + i * cell, y - 11, value, { size: 10, bold: true });
    });
    y -= 26;
  }
  line(MARGIN, y + 6, PAGE_W - MARGIN, y + 6);
  y -= 6;
  header();

  rows.forEach((row) => {
    if (y < MARGIN + 24) newPage();
    const bold = Boolean(row.bold);
    const cells = Array.isArray(row) ? row : row.cells;
    let x = MARGIN;
    cells.forEach((value, i) => {
      const label = clipToWidth(value, widths[i] - 4, 7.5);
      const at = columns[i]?.align === "right" ? x + widths[i] - 2 - textWidth(label, 7.5) : x + 2;
      text(at, y, label, { size: 7.5, bold, gray: row.muted ? 0.4 : 0 });
      x += widths[i];
    });
    if (bold) line(MARGIN, y + ROW_H - 3, PAGE_W - MARGIN, y + ROW_H - 3, 0.5);
    y -= ROW_H;
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
