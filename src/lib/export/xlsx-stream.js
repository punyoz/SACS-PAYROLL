/**
 * A streaming Excel workbook (.xlsx) writer, for exports too big to build in
 * memory (the Super Admin's full data backup, 2026-11-08). Same output format
 * as xlsx.js (Office Open XML, no dependency), but written sheet by sheet,
 * batch by batch, straight to the HTTP response:
 *
 *   const stream = xlsxStream(async function* sheets() {
 *     yield { name: "Payroll", columns: [{ header, width?, integer? }], rows: asyncIterableOfRowArrays };
 *   }, { onFinish(summary), onError(error) });
 *   return new Response(stream, { headers });
 *
 * How it streams: each sheet is a ZIP entry with a data descriptor (sizes and
 * CRC written after the data), so nothing has to be known in advance. Each
 * batch of rows is deflated on its own with a sync flush and the pieces are
 * concatenated (a valid deflate stream); the workbook parts that list the
 * sheets are written last. Memory stays at about one batch of rows.
 *
 * Limits handled here:
 *   - more than MAX_SHEET_ROWS rows: the sheet continues in "<name> (2)", ...
 *   - a cell longer than Excel's 32,767 characters: a column declared with
 *     `parts: n` spreads it over n cells ("<header> (part 2)", ...); anything
 *     still longer is cut with a marker, and counted in summary.truncated_cells
 *   - characters XML cannot hold are dropped.
 */

import { deflateRawSync, constants } from "node:zlib";

export const MAX_SHEET_ROWS = 1_000_000;
export const MAX_CELL_CHARS = 32_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 carried across pieces: start with 0, feed each piece. */
export function crc32Update(crc, buffer) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const escapeXml = (value) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A value as cell text: objects as JSON, booleans as TRUE / FALSE. */
export function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Excel's sheet-name rules: at most 31 characters, none of \ / ? * [ ] :, unique. */
export function sheetNamer() {
  const used = new Set();
  return (wanted) => {
    const base = String(wanted || "Sheet").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

/** Columns as written: a `parts` column becomes n columns. */
export function expandColumns(columns) {
  const out = [];
  (columns || []).forEach((column, source) => {
    const parts = Math.max(1, Number(column.parts) || 1);
    for (let p = 0; p < parts; p += 1) {
      out.push({ ...column, source, part: p, parts, header: p === 0 ? column.header : `${column.header} (part ${p + 1})` });
    }
  });
  return out;
}

/** One row's cells against the expanded columns. Returns { xml, truncated }. */
export function rowXml(rowNumber, values, expanded) {
  let truncated = 0;
  const cells = [];
  expanded.forEach((column, c) => {
    const value = values[column.source];
    const ref = `${columnName(c)}${rowNumber}`;
    if (column.parts === 1 && typeof value === "number" && Number.isFinite(value)) {
      cells.push(`<c r="${ref}"${column.integer ? " s=\"3\"" : column.money ? " s=\"2\"" : ""}><v>${value}</v></c>`);
      return;
    }
    let text = cellText(value);
    if (column.parts > 1) {
      text = text.slice(column.part * MAX_CELL_CHARS, (column.part + 1) * MAX_CELL_CHARS);
      if (column.part === column.parts - 1 && cellText(value).length > column.parts * MAX_CELL_CHARS) {
        text = `${text.slice(0, MAX_CELL_CHARS - 40)}…[cut: ${cellText(value).length - column.parts * MAX_CELL_CHARS} more characters]`;
        truncated += 1;
      }
    } else if (text.length > MAX_CELL_CHARS) {
      text = `${text.slice(0, MAX_CELL_CHARS - 40)}…[cut: ${text.length - (MAX_CELL_CHARS - 40)} more characters]`;
      truncated += 1;
    }
    if (!text) return;
    cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`);
  });
  return { xml: `<row r="${rowNumber}">${cells.join("")}</row>`, truncated };
}

function sheetHead(expanded) {
  const cols = expanded.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join("");
  const header = `<row r="1">${expanded.map((c, i) => `<c r="${columnName(i)}1" t="inlineStr" s="1"><is><t>${escapeXml(c.header)}</t></is></c>`).join("")}</row>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${header}`;
}
const SHEET_TAIL = "</sheetData></worksheet>";

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="1" applyNumberFormat="1"/></cellXfs></styleSheet>`;

/**
 * ZIP writer that hands out byte chunks. entry(name) → { write(text|buffer), end() }.
 */
function zipWriter(emit) {
  const central = [];
  let offset = 0;
  const out = (buffer) => { offset += buffer.length; emit(buffer); };

  function entry(name) {
    const nameBuffer = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // bit 3: sizes in the data descriptor; bit 11: UTF-8 name
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt16LE(nameBuffer.length, 26);
    const start = offset;
    out(Buffer.concat([local, nameBuffer]));
    let crc = 0;
    let size = 0;
    let packed = 0;
    let pending = [];
    let pendingBytes = 0;
    const flush = (final) => {
      const raw = pendingBytes ? Buffer.concat(pending) : Buffer.alloc(0);
      pending = [];
      pendingBytes = 0;
      if (raw.length) {
        crc = crc32Update(crc, raw);
        size += raw.length;
      }
      if (!raw.length && !final) return;
      // A sync flush leaves the stream open for the next piece; the last piece finishes it.
      const piece = deflateRawSync(raw, final ? {} : { finishFlush: constants.Z_SYNC_FLUSH });
      packed += piece.length;
      out(piece);
    };
    return {
      write(data) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        pending.push(buffer);
        pendingBytes += buffer.length;
        if (pendingBytes >= 256 * 1024) flush(false);
      },
      end() {
        flush(true);
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc, 4);
        descriptor.writeUInt32LE(packed, 8);
        descriptor.writeUInt32LE(size, 12);
        out(descriptor);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x0808, 8);
        record.writeUInt16LE(8, 10);
        record.writeUInt16LE(0, 12);
        record.writeUInt16LE(0x21, 14);
        record.writeUInt32LE(crc, 16);
        record.writeUInt32LE(packed, 20);
        record.writeUInt32LE(size, 24);
        record.writeUInt16LE(nameBuffer.length, 28);
        record.writeUInt32LE(start, 42);
        central.push(Buffer.concat([record, nameBuffer]));
      },
    };
  }

  function finish() {
    const centralStart = offset;
    central.forEach((record) => out(record));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    out(end);
  }

  return { entry, finish };
}

/**
 * Write the sheets the async generator yields into a workbook, chunk by chunk.
 * `push(chunk)` receives each Buffer; resolves with a summary of what was written.
 *
 * @param {() => AsyncIterable<{ name: string, columns: Array<object>, rows: AsyncIterable<Array>|Iterable<Array> }>} sheets
 * @param {(chunk: Buffer) => (void|Promise<void>)} push
 */
export async function writeXlsx(sheets, push) {
  const queue = [];
  const zip = zipWriter((buffer) => queue.push(buffer));
  const drain = async () => { while (queue.length) await push(queue.shift()); };
  const name = sheetNamer();
  const written = [];
  let truncatedCells = 0;

  for await (const sheet of sheets()) {
    const expanded = expandColumns(sheet.columns);
    let part = 0;
    let rowsInSheet = 0;
    let current = null;
    const open = () => {
      part += 1;
      const sheetName = name(part === 1 ? sheet.name : `${sheet.name} (${part})`);
      const index = written.length + 1;
      current = { name: sheetName, index, rows: 0, source: sheet.key || sheet.name, entry: zip.entry(`xl/worksheets/sheet${index}.xml`) };
      written.push(current);
      current.entry.write(sheetHead(expanded));
      rowsInSheet = 0;
    };
    open();
    let batch = [];
    for await (const values of sheet.rows) {
      if (rowsInSheet >= MAX_SHEET_ROWS) {
        if (batch.length) { current.entry.write(batch.join("")); batch = []; }
        current.entry.write(SHEET_TAIL);
        current.entry.end();
        await drain();
        open();
      }
      rowsInSheet += 1;
      current.rows += 1;
      const { xml, truncated } = rowXml(rowsInSheet + 1, values, expanded);
      truncatedCells += truncated;
      batch.push(xml);
      if (batch.length >= 500) {
        current.entry.write(batch.join(""));
        batch = [];
        await drain();
      }
    }
    if (batch.length) current.entry.write(batch.join(""));
    current.entry.write(SHEET_TAIL);
    current.entry.end();
    await drain();
  }

  if (!written.length) {
    const empty = zip.entry("xl/worksheets/sheet1.xml");
    empty.write(sheetHead([]) + SHEET_TAIL);
    empty.end();
    written.push({ name: "Sheet1", index: 1, rows: 0 });
  }

  const parts = [
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${written.map((s) => `<sheet name="${escapeXml(s.name)}" sheetId="${s.index}" r:id="rId${s.index}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${written.map((s) => `<Relationship Id="rId${s.index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.index}.xml"/>`).join("")}<Relationship Id="rId${written.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${written.map((s) => `<Override PartName="/xl/worksheets/sheet${s.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
  ];
  parts.forEach(([partName, xml]) => {
    const entry = zip.entry(partName);
    entry.write(xml);
    entry.end();
  });
  zip.finish();
  await drain();
  return { sheets: written.map(({ name: sheetName, rows, source }) => ({ name: sheetName, rows, source })), truncated_cells: truncatedCells };
}

/**
 * The same as a web ReadableStream (for a Next.js Response). Back-pressure:
 * the writer waits whenever the browser is not reading.
 */
export function xlsxStream(sheets, { onFinish, onError } = {}) {
  let controllerRef;
  let waiting = null;
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const push = async (chunk) => {
        // The browser went away (closed the tab, cancelled): stop reading the database.
        if (cancelled) throw new Error("The download was cancelled.");
        controllerRef.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (controllerRef.desiredSize !== null && controllerRef.desiredSize <= 0) {
          await new Promise((resolve) => { waiting = resolve; });
        }
      };
      writeXlsx(sheets, push)
        .then(async (summary) => {
          if (onFinish) await onFinish(summary);
          controllerRef.close();
        })
        .catch(async (error) => {
          if (onError) await onError(error, { cancelled });
          try { controllerRef.error(error); } catch { /* already closed by the browser */ }
        });
    },
    pull() {
      if (waiting) { const resolve = waiting; waiting = null; resolve(); }
    },
    cancel() {
      cancelled = true;
      if (waiting) { const resolve = waiting; waiting = null; resolve(); }
    },
  }, { highWaterMark: 4 });
}
