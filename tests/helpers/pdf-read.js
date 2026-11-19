// Reads a PDF the way a viewer does (pdfjs-dist): every page's size, its text
// runs with their boxes (PDF points, origin at the bottom left), and whether
// an image is drawn. For tests of the PDFs' text and layout.
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function readPdf(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // pdfjs bridges the gap between table cells with whitespace runs: those are dropped.
    const raw = content.items.filter((item) => item.str.trim()).map((item) => {
      const size = Math.hypot(item.transform[2], item.transform[3]);
      const x = item.transform[4];
      const y = item.transform[5];
      // The glyph box: from the descender to the cap height.
      return { text: item.str, size, x0: x, x1: x + item.width, y0: y - 0.22 * size, y1: y + 0.72 * size, y };
    });
    // It also splits a line where kerning moves a glyph: pieces on one baseline closer than a word space are one text.
    const items = [];
    for (const item of raw) {
      const last = items.at(-1);
      const gap = last ? item.x0 - last.x1 : 0;
      if (last && Math.abs(last.y - item.y) < 0.1 && Math.abs(last.size - item.size) < 0.1 && gap > -0.5 && gap < 0.35 * item.size) {
        last.text += (gap > 0.1 * item.size && !/\s$/.test(last.text) && !/^\s/.test(item.text) ? " " : "") + item.text;
        last.x1 = item.x1;
      } else items.push({ ...item });
    }
    items.forEach((item) => { item.text = item.text.replace(/\s+/g, " ").trim(); });
    const ops = await page.getOperatorList();
    const images = ops.fnArray.filter((fn) => fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject).length;
    pages.push({ width, height, items, images });
  }
  const text = pages.flatMap((p) => p.items.map((i) => i.text)).join(" ").replace(/\s+/g, " ");
  return { pages, text };
}
