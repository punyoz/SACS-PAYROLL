// The lines a PDF draws (pdfjs-dist operator list): row borders and box edges
// as segments in PDF points (origin bottom left), for layout tests that check
// no text crosses a line. A thin filled rectangle (how @react-pdf paints a
// 0.5 pt border) counts as a line along its long side; wider fills are
// backgrounds and are left out.
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Segments { x0, y0, x1, y1 } per page, horizontal or vertical, at least 2 pt long. */
export async function readPdfRules(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const { fnArray, argsArray } = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let pending = [];
    const segments = [];
    const keep = (a, b) => {
      const [x0, y0] = a;
      const [x1, y1] = b;
      const horizontal = Math.abs(y0 - y1) < 0.6 && Math.abs(x1 - x0) >= 2;
      const vertical = Math.abs(x0 - x1) < 0.6 && Math.abs(y1 - y0) >= 2;
      if (horizontal || vertical) segments.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
    };
    fnArray.forEach((fn, i) => {
      const args = argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(args, ctm);
      else if (fn === OPS.constructPath) {
        const [ops, coords] = args;
        let at = 0;
        let last = null;
        for (const op of ops) {
          if (op === OPS.moveTo) { last = apply(ctm, coords[at], coords[at + 1]); at += 2; pending.push({ kind: "move", p: last }); }
          else if (op === OPS.lineTo) { const p = apply(ctm, coords[at], coords[at + 1]); at += 2; pending.push({ kind: "line", from: last, p }); last = p; }
          else if (op === OPS.curveTo) at += 6;
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) at += 4;
          else if (op === OPS.rectangle) {
            const [x, y, w, hgt] = coords.slice(at, at + 4);
            at += 4;
            pending.push({ kind: "rect", a: apply(ctm, x, y), b: apply(ctm, x + w, y + hgt) });
          }
        }
      } else if ([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(fn)) {
        const stroked = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(fn);
        for (const part of pending) {
          if (part.kind === "line" && part.from && stroked) keep(part.from, part.p);
          if (part.kind === "rect") {
            const x0 = Math.min(part.a[0], part.b[0]);
            const x1 = Math.max(part.a[0], part.b[0]);
            const y0 = Math.min(part.a[1], part.b[1]);
            const y1 = Math.max(part.a[1], part.b[1]);
            if (stroked) { keep([x0, y0], [x1, y0]); keep([x0, y1], [x1, y1]); keep([x0, y0], [x0, y1]); keep([x1, y0], [x1, y1]); }
            else if (y1 - y0 <= 1.2) keep([x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]);
            else if (x1 - x0 <= 1.2) keep([(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]);
          }
        }
        pending = [];
      } else if (fn === OPS.endPath) pending = [];
    });
    pages.push({ segments });
  }
  return pages;
}

/** Text boxes (readPdf items) that a line runs through: "text × line at y". */
export function crossings(items, segments, slack = 0.3) {
  const found = [];
  for (const t of items) {
    for (const s of segments) {
      const horizontal = s.y1 - s.y0 < 0.6;
      if (horizontal) {
        const overlapX = Math.min(t.x1, s.x1) - Math.max(t.x0, s.x0);
        if (overlapX > 1 && s.y0 > t.y0 + slack && s.y0 < t.y1 - slack) found.push(`${t.text} × line at y ${s.y0.toFixed(2)}`);
      } else {
        const overlapY = Math.min(t.y1, s.y1) - Math.max(t.y0, s.y0);
        if (overlapY > 1 && s.x0 > t.x0 + slack && s.x0 < t.x1 - slack) found.push(`${t.text} × line at x ${s.x0.toFixed(2)}`);
      }
    }
  }
  return found;
}
